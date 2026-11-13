// The focused omp agent's session: id, model, tokens, cost, what it is doing, its summary and its sub-agents.
// Follows the focused agent pane (local or on another machine); keeps the last one while focus is elsewhere.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, focused, hc, layout, theme, window } from "herdr";
import { PROBE, JQ_PROG, shape, fmtTokens, fmtCost, ago } from "./probe.js";

const POLL_MS = 4000;
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

const isOmp = (a) => a?.app === "omp" || a?.program?.key === "omp";
const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");
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
  nosession: "這個 omp 沒有開著的 session 檔",
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
    if (!a || !isOmp(a) || this.loading) return;
    const address = a.address;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const got = await hc(["get", address, "--json"]);
        const fg = got.code === 0 ? JSON.parse(got.stdout)?.foreground : null;
        if (!fg?.pid) { if (this.address === address) { this.error = "noprocess"; this.data = null; } return; }
        const skip = Object.keys(this.kept).join("\n");
        const r = await exec("sh", ["-c", PROBE, "sh", String(fg.pid), skip, JQ_PROG], { on: machineOf(address), timeout: 20000 });
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
        this.at = Date.now();
        cx.notify();
      }
    });
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
        .child(this.tile(t, "花費", fmtCost(m.cost), d.subs.length ? `含 subagent ${fmtCost(d.total)}` : null, t.accent))
        .child(this.tile(t, "目前上下文", fmtTokens(m.ctx), "最後一次請求"))
        .child(this.tile(t, "累計 tokens", fmtTokens(tok.total), d.subs.length ? `subagent ${fmtTokens(d.subTokens)}` : null)),
      div().text_size(10.5).text_color(t.dim).whitespace_normal()
        .child(`輸入 ${fmtTokens(tok.input)} · 輸出 ${fmtTokens(tok.output)} · cache 讀 ${fmtTokens(tok.cacheRead)} · cache 寫 ${fmtTokens(tok.cacheWrite)}`),
      m.aux ? div().text_size(10.5).text_color(t.dim).child(`其中背景呼叫（標題、自動判斷）${fmtCost(m.aux)}`) : null);
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
    return this.card(t, "近況", m.last ? div().text_size(10.5).text_color(t.dim).child(`最後活動 ${ago(m.last)} 前`) : null,
      now,
      m.error ? div().text_size(11.5).text_color(t.blocked).whitespace_normal().child(`錯誤：${m.error}`) : null,
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
    const words = { running: "執行中", done: "已完成", stopped: "已中斷" };
    const note = s.state === "running" ? (s.doing?.intent || s.doing?.tool) : firstLine(s.reply) || s.doing?.intent;
    const model = (s.model ?? "").split("/").pop().replace(/:.*$/, "");
    const row = v_flex().id(id).pl(s.depth * 14).py(5).gap(2).rounded(6).cursor_pointer().hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
      .child(h_flex().gap(6).items_center()
        .child(svg(`${ICON}/${open ? "chevron-down" : "chevron-right"}.svg`).size(11).flex_none().text_color(t.dim))
        .child(this.dot(t, s.state))
        .child(div().min_w(0).truncate().text_size(12).font_semibold().child(s.name))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child([s.agent, model].filter(Boolean).join(" · ")))
        .child(div().flex_none().text_size(11).font_semibold().text_color(t.muted).child(fmtCost(s.cost))))
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

  subagents(t, d) {
    if (!d.subs.length) return this.card(t, "Subagents", null, div().text_size(11.5).text_color(t.dim).child("這個 session 還沒開過 subagent"));
    const c = d.counts;
    const tally = [c.running && `${c.running} 執行中`, c.done && `${c.done} 完成`, c.stopped && `${c.stopped} 中斷`].filter(Boolean).join(" · ");
    return this.card(t, `Subagents · ${d.subs.length}`, div().text_size(10.5).text_color(t.dim).child(`${tally} · ${fmtCost(d.subCost)}`),
      v_flex().children(d.subs.flatMap((s) => this.subRow(t, s))));
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
    if (!isOmp(a)) return note(`目前只支援 omp；這個 agent 是 ${a.program?.name ?? a.app ?? "未知"}。`);
    if (this.error) return note(ERRORS[this.error] ?? `讀取失敗：${this.error}`);
    const d = this.data;
    if (!d) return note("讀取中…");
    return frame.child(v_flex().id("ai-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
      .child(this.session(t, d.main))
      .child(this.usage(t, d))
      .child(this.activity(t, d.main, a))
      .child(this.summary(t, d.main))
      .child(this.subagents(t, d)));
  }
}
