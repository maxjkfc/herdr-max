import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JQ_BRIEF, JQ_FINAL, JQ_STEP, PROBE, SUMMARY, ago, alertsOf, fmtCost, fmtTokens, shape } from "../mods/agent-info/probe.js";

// Real path: lsof reports /private/var for macOS's /var temp folders.
const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-info-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const usage = (total, cost, extra = {}) => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: total, cost: { total: cost }, ...extra });
const reply = (ts, content, u, extra = {}) => ({ type: "message", timestamp: ts, message: { role: "assistant", provider: "anthropic", model: "m1", content, usage: u, ...extra } });
const ask = (ts, text) => ({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
const exit = { type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal" } };
const init = (task) => ({ type: "session_init", task, agent: "task", resolvedModel: "anthropic/m2:high" });

// A main session (with a partly written last line) and three sub-agents, one nested.
const dir = join(root, "sessions", "-code-x");
const main = join(dir, "S.jsonl");
const subDir = join(dir, "S");
const subs = { a: join(subDir, "A.jsonl"), nested: join(subDir, "A", "A.Inner.jsonl"), b: join(subDir, "B.jsonl") };
mkdirSync(join(subDir, "A"), { recursive: true });
writeFileSync(main, jsonl(
  { type: "title", title: "" },
  { type: "session", id: "sid-1", cwd: "/code/x", timestamp: "2026-01-01T00:00:00Z" },
  { type: "title_change", title: "Fix the thing" },
  ask("2026-01-01T00:00:01Z", "first"),
  reply("2026-01-01T00:00:02Z", [{ type: "text", text: "on it" }], usage(100, 0.5)),
  { type: "model_usage", usage: usage(10, 0.01) },
  ask("2026-01-01T00:00:03Z", "second"),
  reply("2026-01-01T00:00:04Z", [{ type: "toolCall", name: "bash" }], usage(200, 1, { input: 50, cacheRead: 1000, cacheWrite: 20, output: 5 })),
  { type: "custom", customType: "tool_execution_start", data: { toolName: "bash", intent: "Running tests", startedAt: "2026-01-01T00:00:05Z" } },
  { type: "compaction", timestamp: "2026-01-01T00:00:06Z", shortSummary: "Remote compaction", summary: "did stuff", tokensBefore: 9000, tokensAfter: 900 },
) + '{"type":"message","message":{"role":"assis');
writeFileSync(subs.a, jsonl({ type: "session", id: "a", timestamp: "2026-01-01T00:01:00Z" }, init("do A"), reply("2026-01-01T00:01:01Z", [{ type: "text", text: "A done" }], usage(30, 0.3)), exit));
writeFileSync(subs.nested, jsonl({ type: "session", id: "n", timestamp: "2026-01-01T00:01:30Z" }, init("do inner"), reply("2026-01-01T00:01:31Z", [], usage(40, 0.4))));
writeFileSync(subs.b, jsonl({ type: "session", id: "b", timestamp: "2026-01-01T00:02:00Z" }, init("do B")));

// One whole file through JQ_STEP from no saved state: its {off, f, s} line.
const step = (kind, file, isMain, models = {}) => {
  const r = Bun.spawnSync(["jq", "-nRc", "--arg", "kind", kind, "--argjson", "isMain", String(isMain), "--arg", "f", file, "--argjson", "off", "0",
    "--argjson", "models", JSON.stringify(models), "--slurpfile", "prev", "/dev/null", JQ_STEP], { stdin: Bun.file(file) });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString();
};

const summarize = (files, open) => {
  const states = files.map((f) => step("omp", f, f === main)).join("");
  const r = Bun.spawnSync(["jq", "-n", "-c", "--arg", "kind", "omp", "--arg", "main", main, "--arg", "open", open.join("\n"), "--arg", "title", "", "--argjson", "metas", "{}", "--argjson", "models", "{}", JQ_FINAL], { stdin: Buffer.from(states) });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.toString());
};

describe("JQ_STEP + JQ_FINAL", () => {
  const raw = summarize([main, subs.a, subs.nested, subs.b], [main, subs.nested]);
  const m = raw.files[main];

  test("sums replies and side calls, skipping a half-written line", () => {
    expect(m.tok.total).toBe(310);
    expect(m.cost).toBeCloseTo(1.51);
    expect(m.aux).toBeCloseTo(0.01);
    expect(m.replies).toBe(2);
  });

  test("keeps the latest title, prompt, text reply, step and compaction", () => {
    expect(m).toMatchObject({ id: "sid-1", title: "Fix the thing", prompt: "second", reply: "on it", prompts: 2, model: "anthropic/m1" });
    expect(m.ctx).toBe(1075);
    expect(m.doing).toEqual({ tool: "bash", intent: "Running tests", at: "2026-01-01T00:00:05Z" });
    expect(m.compaction).toMatchObject({ summary: "did stuff", before: 9000, after: 900 });
  });

  test("reads a sub-agent's task, type and exit", () => {
    expect(raw.files[subs.a]).toMatchObject({ task: "do A", agent: "task", reply: "A done" });
    expect(raw.files[subs.a].exit).toEqual({ reason: "dispose", kind: "normal" });
  });
});

describe("shape", () => {
  const raw = summarize([main, subs.a, subs.nested, subs.b], [main, subs.nested]);
  const s = shape(raw);

  test("sub-agent state: exit → done, held open → running, else stopped", () => {
    expect(Object.fromEntries(s.subs.map((x) => [x.rel, x.state]))).toEqual({ A: "done", "A/A.Inner": "running", B: "stopped" });
    expect(s.counts).toEqual({ running: 1, stopped: 1, done: 1 });
  });

  test("groups with a live sub-agent come first, each parent before its children", () => {
    expect(s.subs.map((x) => [x.rel, x.depth])).toEqual([["A", 0], ["A/A.Inner", 1], ["B", 0]]);
  });

  test("totals add the sub-agents to the main session", () => {
    expect(s.subCost).toBeCloseTo(0.7);
    expect(s.total).toBeCloseTo(2.21);
    expect(s.subTokens).toBe(70);
  });

  test("finished sub-agents kept from an earlier read still count when skipped", () => {
    const again = shape(summarize([main, subs.nested, subs.b], [main, subs.nested]), s.finished);
    expect(Object.keys(s.finished)).toEqual([subs.a]);
    expect(again.subs.map((x) => x.rel)).toEqual(["A", "A/A.Inner", "B"]);
    expect(again.total).toBeCloseTo(2.21);
  });
});

// The saved read states go to the test folder, not the real temp folder.
const env = { ...process.env, TMPDIR: root };
// A process holding one or two session files open, as an agent does.
const hold = (...files) => {
  const holder = Bun.spawn(["sh", "-c", 'exec 3>>"$1" 4>>"${2:-$1}"; exec sleep 30', "sh", ...files]);
  Bun.sleepSync(300);
  return holder;
};

test("PROBE finds the main session and live sub-agents a process holds open", () => {
  const holder = hold(main, subs.nested);
  try {
    const r = Bun.spawnSync(["sh", "-c", PROBE, "sh", "omp", String(holder.pid), subs.a, JQ_STEP, JQ_FINAL, "{}"], { env });
    const raw = JSON.parse(r.stdout.toString());
    expect(raw.main).toBe(main);
    expect(raw.open.sort()).toEqual([main, subs.nested].sort());
    // The skipped finished file is not read again.
    expect(Object.keys(raw.files).sort()).toEqual([main, subs.b, subs.nested].sort());
  } finally {
    holder.kill();
  }
});

test("PROBE reads only what was added: nothing twice, a half-written line once whole, a shrunk file from the start", () => {
  const file = join(root, "sessions", "-inc", "I.jsonl");
  mkdirSync(join(root, "sessions", "-inc"), { recursive: true });
  writeFileSync(file, jsonl(reply("2026-01-01T00:00:01Z", [{ type: "text", text: "one" }], usage(100, 1))) + '{"type":"message","message":{"role":"assis');
  const holder = hold(file);
  const read = () => JSON.parse(Bun.spawnSync(["sh", "-c", PROBE, "sh", "omp", String(holder.pid), "", JQ_STEP, JQ_FINAL, "{}"], { env }).stdout.toString()).files[file];
  const pick = (s) => [s.tok.total, s.replies, s.reply, s.cost];
  try {
    expect(pick(read())).toEqual([100, 1, "one", 1]);
    expect(pick(read())).toEqual([100, 1, "one", 1]);
    appendFileSync(file, 'tant","model":"m1","content":[{"type":"text","text":"two"}],"usage":{"totalTokens":5,"cost":{"total":0.5}}}}\n');
    expect(pick(read())).toEqual([105, 2, "two", 1.5]);
    writeFileSync(file, jsonl(reply("2026-01-01T00:00:02Z", [], usage(7, 0))));
    expect(pick(read())).toEqual([7, 1, undefined, 0]);
  } finally {
    holder.kill();
  }
});

test("SUMMARY reads each listed agent's main session in one run", () => {
  const holder = hold(main, subs.nested);
  try {
    const list = `t1 omp ${holder.pid}\nt2 vim ${holder.pid}\nt3 omp 999999`;
    const r = Bun.spawnSync(["sh", "-c", SUMMARY, "sh", list, JQ_STEP, JQ_BRIEF, JSON.stringify({ m1: { window: 2000 } })], { env });
    const rows = Object.fromEntries(r.stdout.toString().trim().split("\n").map((l) => JSON.parse(l)).map((x) => [x.a, x]));
    expect(rows.t1).toMatchObject({ ctx: 1075, window: 2000, last: "2026-01-01T00:00:06Z", plan: null });
    expect(rows.t1.cost).toBeCloseTo(1.51);
    expect([rows.t2.fail, rows.t3.fail]).toEqual(["unsupported", "nosession"]);
  } finally {
    holder.kill();
  }
});

test("alerts: API error, failing streak, a working agent gone quiet, nearly full context", () => {
  const now = Date.parse("2026-01-01T01:00:00Z");
  const m = { error: "overloaded", errStreak: 3, toolError: { tool: "bash", text: "\nexit 1\nmore" }, last: "2026-01-01T00:45:00Z", ctx: 90, window: 100 };
  expect(alertsOf(m, "working", now).map((x) => [x.key, x.short])).toEqual([["api", "API 錯誤"], ["tools", "失敗 ×3"], ["stale", "15m 沒動靜"], ["ctx", "上下文 90%"]]);
  expect(alertsOf(m, "working", now)[1].detail).toBe("exit 1");
  // Idle and quiet is just idle.
  expect(alertsOf({ ...m, error: null, errStreak: 2, ctx: 10 }, "idle", now)).toEqual([]);
});

test("formatters", () => {
  expect([fmtTokens(999), fmtTokens(1234), fmtTokens(56789), fmtTokens(2_240_000), fmtTokens(77_500_000)]).toEqual(["999", "1.2k", "57k", "2.24M", "77.5M"]);
  expect([fmtCost(0), fmtCost(0.0042), fmtCost(1.856), fmtCost(135.4)]).toEqual(["$0", "$0.0042", "$1.86", "$135"]);
  const now = Date.parse("2026-01-01T03:00:00Z");
  expect([ago("2026-01-01T02:59:30Z", now), ago("2026-01-01T02:48:00Z", now), ago("2026-01-01T00:00:00Z", now), ago(null, now)]).toEqual(["<1m", "12m", "3h", ""]);
});

// One file as the main session of `kind`, as PROBE shows it.
const one = (kind, file, models = {}) => {
  const r = Bun.spawnSync(["jq", "-nc", "--arg", "kind", kind, "--arg", "main", file, "--arg", "open", "", "--arg", "title", "", "--argjson", "metas", "{}", "--argjson", "models", JSON.stringify(models), JQ_FINAL],
    { stdin: Buffer.from(step(kind, file, true, models)) });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.toString()).files[file];
};

test("Claude counts repeated message blocks once but keeps their text and tool activity", () => {
  const file = join(root, "claude.jsonl");
  const message = { id: "msg-1", model: "m", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 4 } };
  writeFileSync(file, jsonl(
    { type: "assistant", sessionId: "s", message: { ...message, content: [{ type: "text", text: "answer" }] } },
    { type: "assistant", sessionId: "s", message: { ...message, content: [{ type: "tool_use", name: "Read", input: { file_path: "file.txt" } }] } },
    { type: "assistant", isSidechain: true, message: { ...message, id: "child", content: [{ type: "text", text: "not the main reply" }] } },
  ));
  const s = one("claude", file, { m: { cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, window: 100 } });
  expect(s.tok.total).toBe(36);
  expect(s.replies).toBe(1);
  expect(s.reply).toBe("answer");
  expect(s.doing.intent).toBe("file.txt");
  expect(s.window).toBe(100);
});

test("Claude: task list, changed files, PR, and failing tools in a row", () => {
  const file = join(root, "claude-work.jsonl");
  const use = (id, content) => ({ type: "assistant", sessionId: "s", message: { id, model: "m", usage: {}, content } });
  const result = (...errs) => ({ type: "user", parentUuid: "p", message: { content: errs.map((e) => ({ type: "tool_result", is_error: e, content: e ? "boom" : "ok" })) } });
  writeFileSync(file, jsonl(
    use("1", [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] } }]),
    use("2", [{ type: "tool_use", name: "Edit", input: { file_path: "/code/x/a.js" } }, { type: "tool_use", name: "Write", input: { file_path: "/code/x/a.js" } }]),
    result(true), result(false), result(true, true),
    { type: "pr-link", prUrl: "https://github.com/o/r/pull/7" },
    { type: "cost-state", totalCostUSD: 1, totalLinesAdded: 12, totalLinesRemoved: 3 },
  ));
  const s = one("claude", file);
  expect(s.plan).toEqual({ total: 3, done: 1, current: "b", items: [{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }] });
  expect(s.touched).toEqual(["/code/x/a.js"]);
  expect([s.toolErrors, s.errStreak]).toEqual([3, 2]);
  expect(s.pr).toBe("https://github.com/o/r/pull/7");
  expect(s.lines).toEqual({ added: 12, removed: 3 });
});

test("omp: todo progress, edited paths, and the PR from gh pr create", () => {
  const file = join(root, "omp-work.jsonl");
  const call = (name, args) => reply("2026-01-01T00:00:01Z", [{ type: "toolCall", name, arguments: args }], usage(1, 0));
  const res = (toolName, text, isError = false, details) => ({ type: "message", message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }], details } });
  writeFileSync(file, jsonl(
    call("edit", { input: "*** Begin Patch\n[/code/x/a.js#AB12]\nPUT 1:\n+x\n[/code/x/b.js#CD34]\nCUT 2\n" }),
    call("write", { path: "local://note.md" }),
    res("edit", "bad anchor", true),
    call("bash", { command: "gh pr create --title t" }),
    res("bash", "https://github.com/o/r/pull/9\n"),
    res("todo", "", false, { phases: [{ name: "P", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "abandoned" }] }] }),
  ));
  const s = one("omp", file, { m1: { window: 1000 } });
  expect(s.touched).toEqual(["/code/x/a.js", "/code/x/b.js"]);
  expect([s.toolErrors, s.errStreak]).toEqual([1, 0]);
  expect(s.pr).toBe("https://github.com/o/r/pull/9");
  expect(s.plan).toEqual({ total: 1, done: 1, current: null, items: [{ text: "a", status: "completed" }] });
  expect(s.window).toBe(1000);
});

test("tokens split by model when the session switches models, side calls marked", () => {
  const file = join(root, "omp-switch.jsonl");
  const on = (ts, model, total, c) => ({ ...reply(ts, [], usage(total, c)), message: { ...reply(ts, [], usage(total, c)).message, model } });
  writeFileSync(file, jsonl(
    on("2026-01-01T00:00:01Z", "opus", 100, 1),
    on("2026-01-01T00:00:02Z", "gpt", 40, 0.2),
    { type: "model_usage", timestamp: "2026-01-01T00:00:03Z", provider: "typesafe", model: "jev", usage: usage(5, 0.01) },
    on("2026-01-01T00:00:04Z", "opus", 60, 0.5),
  ));
  const s = one("omp", file);
  expect(s.tok.total).toBe(205);
  const pick = (u) => ({ tokens: u.tokens, cost: u.cost, calls: u.calls, aux: u.aux, from: u.from, to: u.to });
  expect(pick(s.byModel["anthropic/opus"])).toEqual({ tokens: 160, cost: 1.5, calls: 2, aux: 0, from: "2026-01-01T00:00:01Z", to: "2026-01-01T00:00:04Z" });
  expect(pick(s.byModel["anthropic/gpt"])).toEqual({ tokens: 40, cost: 0.2, calls: 1, aux: 0, from: "2026-01-01T00:00:02Z", to: "2026-01-01T00:00:02Z" });
  expect(pick(s.byModel["typesafe/jev"])).toMatchObject({ tokens: 5, calls: 1, aux: 1 });
  // Usage order, side calls left out: opus, then gpt, then back to opus.
  expect(s.runs.map((r) => [r.model, r.tokens])).toEqual([["anthropic/opus", 100], ["anthropic/gpt", 40], ["anthropic/opus", 60]]);
});

test("Codex uses the latest cumulative usage and rate limits", () => {
  const file = join(root, "codex.jsonl");
  const event = (input, cached, output, percent) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output }, last_token_usage: { input_tokens: 30, output_tokens: 2 }, model_context_window: 100 }, rate_limits: { primary: { used_percent: percent } } } });
  const command = (cmd, code, out) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", cmd], exit_code: code, aggregated_output: out } } });
  writeFileSync(file, jsonl({ type: "session_meta", payload: { id: "c" } }, event(20, 10, 1, 20), event(100, 80, 5, 30),
    command("make", 2, "fail"), command("gh pr create -f", 0, "https://github.com/o/r/pull/3")));
  const s = one("codex", file);
  expect(s.tok).toEqual({ input: 20, output: 5, cacheRead: 80, cacheWrite: 0, total: 105 });
  expect(s.ctx).toBe(32);
  expect(s.window).toBe(100);
  expect(s.limits.primary.used_percent).toBe(30);
  expect([s.toolErrors, s.errStreak, s.pr]).toEqual([1, 0, "https://github.com/o/r/pull/3"]);
});
