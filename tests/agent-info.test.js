import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JQ_PROG, PROBE, ago, fmtCost, fmtTokens, shape } from "../mods/agent-info/probe.js";

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

const summarize = (files, open) => {
  const input = Bun.spawnSync(["grep", "-H", "^", ...files]).stdout;
  const r = Bun.spawnSync(["jq", "-n", "-R", "-c", "--arg", "kind", "omp", "--arg", "main", main, "--arg", "open", open.join("\n"), "--arg", "title", "", "--argjson", "metas", "{}", "--argjson", "models", "{}", JQ_PROG], { stdin: input });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.toString());
};

describe("JQ_PROG", () => {
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

test("PROBE finds the main session and live sub-agents a process holds open", () => {
  const holder = Bun.spawn(["sh", "-c", 'exec 3>>"$1" 4>>"$2"; exec sleep 30', "sh", main, subs.nested]);
  try {
    Bun.sleepSync(300);
    const r = Bun.spawnSync(["sh", "-c", PROBE, "sh", "omp", String(holder.pid), subs.a, JQ_PROG, "{}"]);
    const raw = JSON.parse(r.stdout.toString());
    expect(raw.main).toBe(main);
    expect(raw.open.sort()).toEqual([main, subs.nested].sort());
    // The skipped finished file is not read again.
    expect(Object.keys(raw.files).sort()).toEqual([main, subs.b, subs.nested].sort());
  } finally {
    holder.kill();
  }
});

test("formatters", () => {
  expect([fmtTokens(999), fmtTokens(1234), fmtTokens(56789), fmtTokens(2_240_000), fmtTokens(77_500_000)]).toEqual(["999", "1.2k", "57k", "2.24M", "77.5M"]);
  expect([fmtCost(0), fmtCost(0.0042), fmtCost(1.856), fmtCost(135.4)]).toEqual(["$0", "$0.0042", "$1.86", "$135"]);
  const now = Date.parse("2026-01-01T03:00:00Z");
  expect([ago("2026-01-01T02:59:30Z", now), ago("2026-01-01T02:48:00Z", now), ago("2026-01-01T00:00:00Z", now), ago(null, now)]).toEqual(["<1m", "12m", "3h", ""]);
});

// One file through JQ_PROG as the main session of `kind`.
const one = (kind, file, models = {}) => {
  const input = Bun.spawnSync(["grep", "-H", "^", file]).stdout;
  const r = Bun.spawnSync(["jq", "-nRc", "--arg", "kind", kind, "--arg", "main", file, "--arg", "open", "", "--arg", "title", "", "--argjson", "metas", "{}", "--argjson", "models", JSON.stringify(models), JQ_PROG], { stdin: input });
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
  expect(s.plan).toEqual({ total: 3, done: 1, current: "b" });
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
  expect(s.plan).toEqual({ total: 1, done: 1, current: null });
  expect(s.window).toBe(1000);
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
