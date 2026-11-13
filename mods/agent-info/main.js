// The focused coding agent: whether it needs you (warnings, progress, output), then session, usage and sub-agents.
// Follows the focused agent pane (local or on another machine); keeps the last one while focus is elsewhere.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, focused, hc, layout, theme, window } from "herdr";
import { PROBE, MODELS, JQ_PROG, shape, fmtTokens, fmtCost, ago } from "./probe.js";

const POLL_MS = 4000;
const STALE_MS = 10 * 60000; // "working" with nothing logged for this long: likely stuck
const CTX_WARN = 85; // context % worth a warning
const STREAK_WARN = 3; // tool failures in a row worth a warning
const MONO = "JetBrains Mono";
const ICON = "mods/agent-info/icons";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Shown only while the right panel is open on this block: polling a hidden panel is wasted work.
function visible() {
  const root = layout();
  const panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === "agent");
}

const kindOf = (a) => {
  const names = [a?.app, a?.program?.key];
  if (names.includes("omp")) return "omp";
  if (names.includes("claude") || names.includes("claude-code")) return "claude";
  if (names.includes("codex")) return "codex";
  return null;
};
const cost = (value, unpriced, estimated) => unpriced || value == null ? "—" : `${estimated ? "≈" : ""}${fmtCost(value)}`;
const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");
const pct = (m) => (m.window && m.ctx != null ? Math.round((m.ctx / m.window) * 100) : null);
const home = (p) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
// A changed file, relative to the session's folder when inside it.
const shortPath = (p, cwd) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : home(p));
const firstLine = (s) => (s ?? "").split("\n").find((l) => l.trim()) ?? "";
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function when(iso) {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

const ERRORS = {
  nojq: "這台機器找不到 jq，無法讀 session（brew install jq）",
  nosession: "找不到這個 agent 的 session 檔",
  noprocess: "這個 terminal 沒有在跑的程式",
};

export default class AgentInfo extends View {
  init(_props, cx) {
    this.address = null; // the agent shown
    this.data = null;
    this.error = null;
    this.loading = false;
    this.at = 0;
    this.kept = {}; // finished sub-agents' summaries: their files never change again
    this.mainPath = null;
    this.expanded = new Set();
    this.showSummary = false;
    this.models = new Map(); // machine → { json, at }: omp's model rates and context windows, read hourly
    cx.timer.every(POLL_MS, (cx) => { if (window()?.active && visible()) this.refresh(cx); });
  }

  // The focused agent, else the one shown before (focus may be in a non-agent pane), else the focused space's first.
  target() {
    const list = agents();
    const f = focused();
    return list.find((a) => a.address === f?.terminal)
      ?? list.find((a) => a.address === this.address)
      ?? list.find((a) => a.space === f?.space)
      ?? null;
  }

  select(address) {
    if (address === this.address) return;
    this.address = address;
    this.data = null; this.error = null; this.kept = {}; this.mainPath = null;
    this.expanded = new Set(); this.showSummary = false; this.at = 0;
  }

  refresh(cx) {
    const a = this.target();
    this.select(a?.address ?? null);
    const kind = kindOf(a);
    if (!a || !kind || this.loading) return;
    const address = a.address;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const got = await hc(["get", address, "--json"]);
        const fg = got.code === 0 ? JSON.parse(got.stdout)?.foreground : null;
        if (!fg?.pid) { if (this.address === address) { this.error = "noprocess"; this.data = null; } return; }
        const on = machineOf(address);
        const models = await this.modelsOn(on);
        const skip = Object.keys(this.kept).join("\n");
        const r = await exec("sh", ["-c", PROBE, "sh", kind, String(fg.pid), skip, JQ_PROG, models], { on, timeout: 20000 });
        if (this.address !== address) return;
        const raw = JSON.parse(r.stdout || "{}");
        if (raw.error || !raw.main) { this.error = raw.error ?? (r.stderr.trim() || `exit ${r.code}`); this.data = null; return; }
        if (raw.main !== this.mainPath) { this.mainPath = raw.main; this.kept = {}; }
        this.data = shape(raw, this.kept);
        this.kept = this.data.finished;
        this.error = null;
      } catch (e) {
        if (this.address === address) { this.error = String(e?.message ?? e); this.data = null; }
      } finally {
        this.loading = false;
        this.at = this.address === address ? Date.now() : 0;
        cx.notify();
      }
    });
  }

  async modelsOn(on) {
    const key = on ?? "";
    const hit = this.models.get(key);
    if (hit && Date.now() - hit.at < 3600000) return hit.json;
    const json = (await exec("sh", ["-c", MODELS], { on, timeout: 20000 })).stdout.trim() || "{}";
    this.models.set(key, { json, at: Date.now() });
    return json;
  }

  card(t, title, right, ...rows) {
    return v_flex().gap(6).p(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().items_center().justify_between().gap(8)
        .child(div().text_size(11).text_color(t.dim).font_semibold().child(title))
        .when(Boolean(right), (el) => el.child(right)))
      .children(rows.filter(Boolean));
  }

  line(t, name, value, color) {
    return h_flex().items_center().justify_between().gap(10).min_h(17)
      .child(div().flex_none().text_color(t.muted).child(name))
      .child(div().min_w(0).truncate().font_semibold().text_color(color ?? t.foreground).child(value));
  }

  // A labelled paragraph; long text folds behind a click.
  para(t, id, label, text, limit) {
    if (!text) return null;
    const open = this.expanded.has(id);
    const long = text.length > limit;
    return v_flex().gap(2)
      .child(div().text_size(10.5).text_color(t.dim).child(label))
      .child(div().id(id).text_size(12).text_color(t.foreground).whitespace_normal()
        .when(long, (el) => el.cursor_pointer().hover((x) => x.text_color(t.muted)).tooltip(open ? "收合" : "展開全文")
          .on_click((_e, cx) => { this.toggle(id); cx.notify(); }))
        .child(open || !long ? text : `${text.slice(0, limit)}…`));
  }

  toggle(id) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
  }

  tile(t, label, value, sub, color) {
    return v_flex().flex_1().min_w(0).gap(2).p(8).rounded(8).bg(t.background).border_1().border_color(t.border)
      .child(div().text_size(10.5).text_color(t.dim).child(label))
      .child(div().text_size(18).font_bold().text_color(color ?? t.foreground).child(value))
      .when(Boolean(sub), (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(sub)));
  }

  dot(t, state, size = 7) {
    if (state === "running" || state === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    const color = { done: t.done, blocked: t.blocked, stopped: t.warning ?? t.blocked, idle: t.dim }[state] ?? t.dim;
    return div().size(size).mx(2.5).flex_none().rounded(size / 2).bg(color);
  }

  header(t, a) {
    const status = a?.status;
    const words = { working: "工作中", blocked: "等你回應", done: "完成", idle: "閒置" };
    const where = a ? `${a.space_name} / ${clean(a.tab_name) || a.tab_index}` : "";
    const machine = machineOf(a?.address);
    return h_flex().h(40).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(a?.program?.icon
        ? (a.program.tint ? svg(a.program.icon).size(16).flex_none().text_color(t.muted) : image(a.program.icon).w(16).h(16).flex_none())
        : svg(`${ICON}/agent.svg`).size(16).flex_none().text_color(t.muted))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12.5).font_semibold().truncate().child(a ? (a.program?.name ?? "Agent") : "Agent"))
        .child(div().text_size(10.5).text_color(t.dim).truncate().child(a ? `${where}${machine ? ` · ${machine}` : ""}` : "沒有 agent")))
      .when(Boolean(status), (el) => el.child(h_flex().flex_none().gap(4).items_center()
        .child(this.dot(t, status))
        .child(div().text_size(11).text_color(t.muted).child(words[status] ?? status))))
      .child(div().id("ai-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
        .hover((x) => x.bg(t.hover)).tooltip("重新讀取")
        .on_click((_e, cx) => this.refresh(cx))
        .child(this.loading
          ? svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.muted).spin(900)
          : svg(`${ICON}/refresh.svg`).size(13).text_color(t.muted)));
  }

  session(t, m) {
    const copy = div().id("ai-copy-id").flex_none().size(20).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .hover((x) => x.bg(t.hover)).tooltip("複製 Session ID")
      .on_click((_e, cx) => cx.write_to_clipboard(m.id ?? ""))
      .child(svg(`${ICON}/copy.svg`).size(12).text_color(t.muted));
    return this.card(t, "Session", null,
      m.title ? div().text_size(13).font_semibold().whitespace_normal().child(clean(m.title)) : null,
      h_flex().items_center().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_family(MONO).text_color(t.muted).child(m.id ?? "?"))
        .child(copy),
      this.line(t, "模型", m.model ?? "?"),
      this.line(t, "開始", m.started ? `${when(m.started)}（${ago(m.started)} 前）` : "?"),
      this.line(t, "指令 / 回覆", `${m.prompts ?? 0} / ${m.replies ?? 0}`));
  }

  usage(t, d) {
    const m = d.main, tok = m.tok ?? {};
    return this.card(t, "用量", null,
      h_flex().gap(8)
        .child(this.tile(t, d.estimated ? "花費（估算）" : "花費", cost(m.cost, m.unpriced, d.estimated), d.subs.length ? `含 subagent ${cost(d.total, d.unpriced, d.estimated)}` : null, t.accent))
        .child(this.tile(t, "目前上下文", pct(m) != null ? `${pct(m)}%` : fmtTokens(m.ctx),
          m.window ? `${fmtTokens(m.ctx)} / ${fmtTokens(m.window)}` : "最後一次請求",
          pct(m) >= CTX_WARN ? (t.warning ?? t.blocked) : null))
        .child(this.tile(t, "累計 tokens", fmtTokens(tok.total), d.subs.length ? `subagent ${fmtTokens(d.subTokens)}` : null)),
      div().text_size(10.5).text_color(t.dim).whitespace_normal()
        .child(`輸入 ${fmtTokens(tok.input)} · 輸出 ${fmtTokens(tok.output)} · cache 讀 ${fmtTokens(tok.cacheRead)} · cache 寫 ${fmtTokens(tok.cacheWrite)}`),
      d.estimated ? div().text_size(10.5).text_color(t.dim).whitespace_normal().child("依 agent 所在機器的模型價目估算，非帳單；缺價目顯示 —") : null,
      m.limits ? div().text_size(10.5).text_color(t.dim).child(`Codex 配額：5h ${m.limits.primary?.used_percent ?? "—"}% · 週 ${m.limits.secondary?.used_percent ?? "—"}%`) : null,
      m.aux ? div().text_size(10.5).text_color(t.dim).child(`其中背景呼叫（標題、自動判斷）${fmtCost(m.aux)}`) : null);
  }

  // Reasons to look now: each names what the log shows, not a guess at the cause.
  alerts(t, m, a) {
    const list = [];
    if (m.error) list.push(["API 錯誤", m.error]);
    if ((m.errStreak ?? 0) >= STREAK_WARN)
      list.push([`工具連續失敗 ${m.errStreak} 次${m.toolError?.tool ? `（${m.toolError.tool}）` : ""}`, firstLine(m.toolError?.text)]);
    if (a?.status === "working" && m.last && Date.now() - Date.parse(m.last) > STALE_MS)
      list.push([`顯示工作中，但已 ${ago(m.last)} 沒有新紀錄`, "可能卡住，或在跑很久的指令"]);
    if (pct(m) >= CTX_WARN) list.push([`上下文已用 ${pct(m)}%`, "接近上限，之後會壓縮或需要開新 session"]);
    if (!list.length) return null;
    const color = t.warning ?? t.blocked;
    return v_flex().gap(6).p(10).rounded(10).bg(t.surface).border_1().border_color(color)
      .child(div().text_size(11).font_semibold().text_color(color).child("需要注意"))
      .children(list.map(([head, detail]) => v_flex().gap(1)
        .child(div().text_size(12).font_semibold().whitespace_normal().child(head))
        .when(Boolean(detail), (el) => el.child(div().text_size(11).text_color(t.muted).whitespace_normal().child(clip(detail, 200))))));
  }

  // The agent's own task list, the PR it opened and the files it changed.
  progress(t, m) {
    const p = m.plan;
    const files = m.touched ?? [];
    const rows = [];
    if (p?.total) {
      const share = Math.round((p.done / p.total) * 100);
      rows.push(h_flex().items_center().gap(8)
        .child(div().flex_none().font_semibold().child(`${p.done} / ${p.total} 完成`))
        .child(div().flex_1().h(5).rounded(3).bg(t.background).overflow_hidden()
          .child(div().h(5).w(`${Math.max(share, 2)}%`).rounded(3).bg(p.done === p.total ? t.done : t.accent))));
      if (p.current) rows.push(div().text_size(11.5).text_color(t.muted).whitespace_normal().child(`進行中：${clip(p.current, 200)}`));
    }
    if (m.pr) {
      const [, repo, num] = m.pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/) ?? [];
      rows.push(h_flex().id("ai-pr").gap(6).items_center().cursor_pointer().rounded(6).hover((x) => x.bg(t.hover)).tooltip(m.pr)
        .on_click(() => exec("open", [m.pr]))
        .child(div().flex_none().text_color(t.muted).child("PR"))
        .child(div().min_w(0).truncate().font_semibold().text_color(t.accent).child(num ? `#${num} · ${repo}` : m.pr)));
    }
    if (files.length || m.lines) {
      const lines = m.lines ? ` · +${m.lines.added} −${m.lines.removed} 行` : "";
      const open = this.expanded.has("ai-files");
      const shown = open ? files : files.slice(-5);
      rows.push(v_flex().gap(2)
        .child(h_flex().id("ai-files").gap(6).items_center()
          .when(files.length > 5, (el) => el.cursor_pointer().tooltip(open ? "收合" : "顯示全部")
            .on_click((_e, cx) => { this.toggle("ai-files"); cx.notify(); }))
          .child(div().text_color(t.muted).child(`改了 ${files.length} 個檔${lines}`))
          .when(files.length > 5, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(open ? "收合" : `顯示全部（最近 5 個）`))))
        .children(shown.map((f) => div().text_size(11).font_family(MONO).text_color(t.dim).truncate().child(shortPath(f, m.cwd)))));
    }
    if (!rows.length) rows.push(div().text_size(11.5).text_color(t.dim).whitespace_normal().child("還沒有任務清單、PR 或改過的檔案"));
    return this.card(t, "進度與產出", null, ...rows);
  }

  activity(t, m, a) {
    const doing = m.doing;
    // Its latest step while it works, or what it is asking while it waits for you.
    const now = doing && (a?.status === "working" || a?.status === "blocked")
      ? h_flex().gap(6).items_center()
        .child(this.dot(t, a.status))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(doing.intent || doing.tool))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${doing.tool} · ${ago(doing.at)}`))
      : null;
    const fails = m.toolErrors ? div().text_size(10.5).text_color(t.dim).child(`工具失敗共 ${m.toolErrors} 次${m.errStreak ? `，最近連續 ${m.errStreak} 次` : ""}`) : null;
    return this.card(t, "近況", m.last ? div().text_size(10.5).text_color(t.dim).child(`最後活動 ${ago(m.last)} 前`) : null,
      now,
      fails,
      this.para(t, "ai-prompt", "最後的指令", m.prompt, 220),
      this.para(t, "ai-reply", "最後的回覆", m.reply, 320));
  }

  summary(t, m) {
    const c = m.compaction;
    if (!c) return this.card(t, "摘要", null, div().text_size(11.5).text_color(t.dim).whitespace_normal()
      .child("還沒壓縮過上下文，所以沒有摘要；標題就是這個 session 的一句話摘要。"));
    const stats = `壓縮 ${m.compactions} 次 · 最近 ${when(c.at)} · ${fmtTokens(c.before)} → ${fmtTokens(c.after)}`;
    return this.card(t, "摘要", null,
      div().text_size(10.5).text_color(t.dim).child(stats),
      c.summary
        ? this.para(t, "ai-summary", c.short && c.short !== "Remote compaction" ? c.short : "壓縮摘要", c.summary, 400)
        : div().text_size(11.5).text_color(t.dim).whitespace_normal().child(`${c.short ?? "壓縮"}：供應商端壓縮，沒有留下文字摘要`));
  }

  subRow(t, s) {
    const id = `ai-sub-${s.rel}`;
    const open = this.expanded.has(id);
    const words = { running: "執行中", done: "已完成", stopped: "已中斷", unknown: "狀態未知" };
    const note = s.state === "running" ? (s.doing?.intent || s.doing?.tool) : firstLine(s.reply) || s.doing?.intent;
    const model = (s.model ?? "").split("/").pop().replace(/:.*$/, "");
    const row = v_flex().id(id).pl(s.depth * 14).py(5).gap(2).rounded(6).cursor_pointer().hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .child(svg(`${ICON}/${open ? "chevron-down" : "chevron-right"}.svg`).size(11).flex_none().text_color(t.dim))
        .child(this.dot(t, s.state))
        .child(div().min_w(0).truncate().text_size(12).font_semibold().child(s.name))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child([s.agent, model].filter(Boolean).join(" · ")))
        .child(div().flex_none().text_size(11).font_semibold().text_color(t.muted).child(cost(s.cost, s.unpriced, this.data?.estimated))))
      .when(Boolean(note), (el) => el.child(div().pl(30).text_size(11).text_color(t.muted).truncate()
        .child(`${s.state === "running" ? "" : `${words[s.state]} · `}${clip(note, 140)}${s.last ? ` · ${ago(s.last)}` : ""}`)));
    if (!open) return [row];
    const detail = v_flex().ml(30 + s.depth * 14).mb(4).p(8).gap(6).rounded(8).bg(t.background).border_1().border_color(t.border)
      .child(div().text_size(10.5).text_color(t.dim).child(
        `${words[s.state]} · tokens ${fmtTokens(s.tok?.total)} · 上下文 ${fmtTokens(s.ctx)} · ${s.replies ?? 0} 次回覆${s.started ? ` · 開始 ${when(s.started)}` : ""}`))
      .when(Boolean(s.error), (el) => el.child(div().text_size(11).text_color(t.blocked).whitespace_normal().child(`錯誤：${s.error}`)))
      .when(Boolean(s.task), (el) => el.child(this.para(t, `${id}-task`, "任務", s.task.replace(/^Complete assignment thoroughly:\s*/, ""), 300)))
      .when(Boolean(s.reply), (el) => el.child(this.para(t, `${id}-reply`, s.state === "done" ? "結果" : "最後的回覆", s.reply, 300)));
    return [row, detail];
  }

  // Folded to a one-line tally: open it when tracking a sub-agent down.
  subagents(t, d) {
    if (!d.subs.length) return this.card(t, "Subagents", null, div().text_size(11.5).text_color(t.dim).child("這個 session 還沒開過 subagent"));
    const c = d.counts;
    const open = this.expanded.has("ai-subs");
    const tally = [c.running && `${c.running} 執行中`, c.done && `${c.done} 完成`, c.stopped && `${c.stopped} 中斷`, c.unknown && `${c.unknown} 未知`].filter(Boolean).join(" · ");
    return v_flex().gap(6).p(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().id("ai-subs").items_center().gap(6).cursor_pointer()
        .on_click((_e, cx) => { this.toggle("ai-subs"); cx.notify(); })
        .child(svg(`${ICON}/${open ? "chevron-down" : "chevron-right"}.svg`).size(11).flex_none().text_color(t.dim))
        .child(div().flex_none().text_size(11).text_color(t.dim).font_semibold().child(`Subagents · ${d.subs.length}`))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim)
          .child(`${tally} · ${cost(d.subCost, d.subs.some((s) => s.unpriced), d.estimated)}`)))
      .when(open, (el) => el.child(v_flex().children(d.subs.flatMap((s) => this.subRow(t, s)))));
  }

  render(cx) {
    const t = theme();
    const a = this.target();
    // A new focused agent, or the panel just opened on stale numbers: read now, not at the next tick.
    if (visible() && (a?.address !== this.address || Date.now() - this.at > POLL_MS)) this.refresh(cx);
    const frame = v_flex().id("agent-info").size_full().bg(t.background).text_color(t.foreground).text_size(12)
      .child(this.header(t, a));
    const note = (text) => frame.child(div().p(16).text_size(12).text_color(t.dim).whitespace_normal().child(text));
    if (!a) return note("先點一個 agent 的 pane，這裡會顯示它的 session、用量與 subagent。");
    if (!kindOf(a)) return note(`不支援這個 agent：${a.program?.name ?? a.app ?? "未知"}。`);
    if (this.error) return note(ERRORS[this.error] ?? `讀取失敗：${this.error}`);
    const d = this.data;
    if (!d) return note("讀取中…");
    return frame.child(v_flex().id("ai-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
      .children([this.alerts(t, d.main, a)].filter(Boolean))
      .child(this.progress(t, d.main))
      .child(this.session(t, d.main))
      .child(this.usage(t, d))
      .child(this.activity(t, d.main, a))
      .child(this.summary(t, d.main))
      .child(this.subagents(t, d)));
  }
}
