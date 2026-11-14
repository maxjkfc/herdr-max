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
// Markdown emphasis, code ticks and heading marks dropped: the panel shows plain text.
const unmark = (s) => (s ?? "").replace(/\*\*|__|`/g, "").replace(/^\s*#+\s+/gm, "").trim();
// The first paragraph of a reply, list marks dropped too: its gist.
const lead = (s) => unmark((s ?? "").split(/\n\s*\n/).find((p) => p.trim()) ?? "").replace(/^\s*([-*]|\d+\.)\s+/gm, "").replace(/\s*\n\s*/g, " ");

const STATES = {
  working: { word: "工作中", color: "working" },
  blocked: { word: "等你回應", color: "blocked" },
  done: { word: "完成", color: "done" },
  idle: { word: "閒置", color: "idle" },
};

// "HH:MM" today, else "M/D HH:MM"; `dated` always adds the date.
function when(iso, dated = false) {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return !dated && d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
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
    return v_flex().gap(8).p(12).rounded(10).bg(t.surface).border_1().border_color(t.border)
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

  // A folding row: chevron, title, and a dim summary that stays visible while folded.
  fold(t, id, title, summary) {
    const open = this.expanded.has(id);
    return h_flex().id(id).items_center().gap(6).cursor_pointer()
      .on_click((_e, cx) => { this.toggle(id); cx.notify(); })
      .child(svg(`${ICON}/${open ? "chevron-down" : "chevron-right"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().flex_none().text_size(11).text_color(t.dim).font_semibold().child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(summary ?? ""));
  }

  bar(t, share, color, h = 4) {
    return div().w_full().h(h).rounded(h / 2).bg(t.border).overflow_hidden()
      .child(div().h(h).w(`${Math.min(100, Math.max(share, 2))}%`).rounded(h / 2).bg(color));
  }

  dot(t, state, size = 7) {
    if (state === "running" || state === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    const color = { done: t.done, blocked: t.blocked, stopped: t.blocked, idle: t.dim }[state] ?? t.dim;
    return div().size(size).mx(2.5).flex_none().rounded(size / 2).bg(color);
  }

  header(t, a) {
    const where = a ? `${a.space_name} / ${clean(a.tab_name) || a.tab_index}` : "";
    const machine = machineOf(a?.address);
    return h_flex().h(40).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(a?.program?.icon
        ? (a.program.tint ? svg(a.program.icon).size(16).flex_none().text_color(t.muted) : image(a.program.icon).w(16).h(16).flex_none())
        : svg(`${ICON}/agent.svg`).size(16).flex_none().text_color(t.muted))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12.5).font_semibold().truncate().child(a ? (a.program?.name ?? "Agent") : "Agent"))
        .child(div().text_size(10.5).text_color(t.dim).truncate().child(a ? `${where}${machine ? ` · ${machine}` : ""}` : "沒有 agent")))
      .child(div().id("ai-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
        .hover((x) => x.bg(t.hover)).tooltip("重新讀取")
        .on_click((_e, cx) => this.refresh(cx))
        .child(this.loading
          ? svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.muted).spin(900)
          : svg(`${ICON}/refresh.svg`).size(13).text_color(t.muted)));
  }

  // Reasons to look now: each names what the log shows, not a guess at the cause.
  alerts(m, a) {
    const list = [];
    if (m.error) list.push(["API 錯誤", m.error]);
    if ((m.errStreak ?? 0) >= STREAK_WARN)
      list.push([`工具連續失敗 ${m.errStreak} 次${m.toolError?.tool ? `（${m.toolError.tool}）` : ""}`, firstLine(m.toolError?.text)]);
    if (a?.status === "working" && m.last && Date.now() - Date.parse(m.last) > STALE_MS)
      list.push([`顯示工作中，但已 ${ago(m.last)} 沒有新紀錄`, "可能卡住，或在跑很久的指令"]);
    if (pct(m) >= CTX_WARN) list.push([`上下文已用 ${pct(m)}%`, "接近上限，之後會壓縮或需要開新 session"]);
    return list;
  }

  // The one block to read: its state, what the session is, what it is doing or saying now, and warnings.
  hero(t, d, a) {
    const m = d.main;
    const s = STATES[a?.status] ?? { word: a?.status ?? "未知", color: "unknown" };
    const color = t[s.color] ?? t.dim;
    // A step logged before the latest prompt belongs to the previous turn.
    const step = m.doing && (!m.promptAt || m.doing.at >= m.promptAt) ? m.doing : null;
    const [label, text, meta] = a?.status === "working"
      ? ["正在做", step ? (step.intent || step.tool) : "思考中", step ? `${step.tool} · ${ago(step.at)}` : null]
      : a?.status === "blocked" ? ["在等你", lead(m.reply) || "等你回應", null]
      : ["最後結果", lead(m.reply), null];
    const alerts = this.alerts(m, a);
    return v_flex().gap(10).p(12).rounded(10).bg(`${color}14`).border_1().border_color(`${color}55`)
      .child(h_flex().items_center().gap(8)
        .child(h_flex().flex_none().gap(5).items_center().px(8).h(22).rounded(11).bg(`${color}26`)
          .child(this.dot(t, a?.status))
          .child(div().text_size(11.5).font_semibold().text_color(color).child(s.word)))
        .child(div().flex_1())
        .when(Boolean(m.last), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`最後活動 ${ago(m.last)} 前`))))
      .child(div().text_size(15).font_semibold().whitespace_normal().child(clean(m.title) || "（沒有標題）"))
      .when(Boolean(text), (el) => el.child(v_flex().gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(10.5).font_semibold().text_color(color).child(label))
          .when(Boolean(meta), (x) => x.child(div().text_size(10.5).text_color(t.dim).child(meta))))
        .child(div().text_size(12.5).whitespace_normal().child(clip(text, 260)))))
      .when(alerts.length > 0, (el) => el.child(v_flex().gap(8).pt(10).border_t(1).border_color(`${color}40`)
        .children(alerts.map(([head, detail]) => h_flex().items_start().gap(8)
          .child(svg(`${ICON}/alert.svg`).size(14).flex_none().mt(1).text_color(t.blocked))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(12).font_semibold().text_color(t.blocked).whitespace_normal().child(head))
            .when(Boolean(detail), (x) => x.child(div().text_size(11).text_color(t.muted).whitespace_normal().child(clip(detail, 200)))))))));
  }

  stat(t, label, value, sub, share, color) {
    return v_flex().flex_1().min_w(0).gap(4).p(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(10.5).text_color(t.dim).child(label))
      .child(div().text_size(20).font_bold().text_color(color ?? t.foreground).child(value))
      // Same height with or without a bar: the three numbers line up.
      .child(share != null ? this.bar(t, share, color ?? t.accent) : div().h(4))
      .when(Boolean(sub), (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(sub)));
  }

  // Three numbers worth a glance: how far along, how full, how much.
  stats(t, d) {
    const m = d.main, p = m.plan, ctx = pct(m);
    const ctxColor = ctx >= CTX_WARN ? t.blocked : ctx >= 60 ? t.working : t.accent;
    return h_flex().gap(8)
      .child(p?.total
        ? this.stat(t, "任務", `${p.done}/${p.total}`, p.done === p.total ? "全部完成" : `剩 ${p.total - p.done} 項`, (p.done / p.total) * 100, p.done === p.total ? t.done : t.accent)
        : this.stat(t, "任務", "—", "沒有任務清單"))
      .child(ctx != null
        ? this.stat(t, "上下文", `${ctx}%`, `${fmtTokens(m.ctx)} / ${fmtTokens(m.window)}`, ctx, ctxColor)
        : this.stat(t, "上下文", fmtTokens(m.ctx), "上限未知"))
      .child(this.stat(t, d.estimated ? "花費（估算）" : "花費", cost(m.cost, m.unpriced, d.estimated),
        d.subs.length ? `含 subagent ${cost(d.total, d.unpriced, d.estimated)}` : `${m.replies ?? 0} 次回覆`));
  }

  // The agent's own list: what's left stays visible, finished items fold away.
  tasks(t, m, a) {
    const p = m.plan;
    if (!p?.items?.length) return null;
    const open = this.expanded.has("ai-done");
    const done = p.items.filter((i) => i.status === "completed").length;
    const rows = p.items.filter((i) => open || i.status !== "completed" || done <= 2).map((i) => {
      const live = i.status === "in_progress";
      const mark = i.status === "completed" ? svg(`${ICON}/check.svg`).size(13).flex_none().text_color(t.done)
        : live && a?.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900)
        : live ? div().size(9).m(2).flex_none().rounded(5).bg(t.accent)
        : div().size(9).m(2).flex_none().rounded(5).border_1().border_color(t.dim);
      return h_flex().items_start().gap(8)
        .child(div().mt(1).flex_none().child(mark))
        .child(div().flex_1().min_w(0).whitespace_normal().text_size(12)
          .text_color(i.status === "completed" ? t.dim : t.foreground)
          .when(live, (x) => x.font_semibold())
          .child(i.text));
    });
    return this.card(t, `任務 · ${p.done}/${p.total}`,
      done > 2 ? div().id("ai-done").text_size(10.5).text_color(t.dim).cursor_pointer().hover((x) => x.text_color(t.muted))
        .on_click((_e, cx) => { this.toggle("ai-done"); cx.notify(); })
        .child(open ? "隱藏已完成" : `顯示已完成 ${done} 項`) : null,
      v_flex().gap(6).children(rows));
  }

  // What it produced: the PR it opened and the files it changed.
  output(t, m) {
    const files = m.touched ?? [];
    if (!m.pr && !files.length && !m.lines) return null;
    const rows = [];
    if (m.pr) {
      const [, repo, num] = m.pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/) ?? [];
      rows.push(h_flex().id("ai-pr").gap(8).items_center().px(8).h(30).rounded(8).bg(`${t.accent}14`).border_1().border_color(`${t.accent}40`)
        .cursor_pointer().hover((x) => x.bg(`${t.accent}26`)).tooltip(m.pr)
        .on_click(() => exec("open", [m.pr]))
        .child(svg(`${ICON}/pr.svg`).size(14).flex_none().text_color(t.accent))
        .child(div().flex_none().font_bold().text_color(t.accent).child(num ? `#${num}` : "PR"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(repo ?? m.pr))
        .child(svg(`${ICON}/external.svg`).size(12).flex_none().text_color(t.dim)));
    }
    if (files.length) {
      const open = this.expanded.has("ai-files");
      const shown = open ? files : files.slice(-5);
      rows.push(v_flex().gap(3).children(shown.map((f) => {
        const rel = shortPath(f, m.cwd);
        const cut = rel.lastIndexOf("/");
        return h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().text_size(11.5).font_family(MONO).font_semibold().child(rel.slice(cut + 1)))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_family(MONO).text_color(t.dim).child(cut > 0 ? rel.slice(0, cut) : ""));
      })));
    }
    const lines = m.lines ? `+${m.lines.added} −${m.lines.removed} 行` : null;
    const count = files.length ? `${files.length} 個檔` : null;
    return this.card(t, ["產出", count, lines].filter(Boolean).join(" · "),
      files.length > 5 ? div().id("ai-files").text_size(10.5).text_color(t.dim).cursor_pointer().hover((x) => x.text_color(t.muted))
        .on_click((_e, cx) => { this.toggle("ai-files"); cx.notify(); })
        .child(this.expanded.has("ai-files") ? "只看最近 5 個" : `全部 ${files.length} 個`) : null,
      ...rows);
  }

  // Cumulative tokens as pictures: one bar in usage order (each run of replies on a model, sized by its tokens),
  // each model's share, and the switch log. Background side calls fold into one line.
  usage(t, d) {
    const m = d.main;
    const total = m.tok?.total ?? 0;
    const all = Object.entries(m.byModel ?? {});
    const models = all.filter(([, u]) => u.aux < u.calls).sort(([, a], [, b]) => (a.from ?? "").localeCompare(b.from ?? ""));
    const side = all.filter(([, u]) => u.aux === u.calls);
    const palette = [t.accent, t.ansi5, t.ansi3, t.ansi6, t.ansi2, t.ansi1].filter(Boolean);
    const color = new Map(models.map(([k], i) => [k, palette[i % palette.length]]));
    const name = (k) => k.split("/").pop().replace(/:.*$/, "");
    const runs = m.runs ?? [];
    const runTotal = runs.reduce((n, r) => n + r.tokens, 0);
    const days = runs.length && new Date(runs[0].from).toDateString() !== new Date(runs[runs.length - 1].to).toDateString();
    const at = (iso) => when(iso, days);
    const swatch = (k) => div().size(8).flex_none().rounded(2).bg(color.get(k) ?? t.dim);

    const head = h_flex().items_end().gap(8)
      .child(div().text_size(22).font_bold().child(fmtTokens(total)))
      .child(div().pb(3).text_size(10.5).text_color(t.dim).truncate()
        .child([models.length > 1 && `${models.length} 個模型`, d.subs.length && `另 subagent ${fmtTokens(d.subTokens)}`].filter(Boolean).join(" · ")));

    const timeline = runTotal ? v_flex().gap(3)
      .child(h_flex().w_full().h(12).gap(1).rounded(3).overflow_hidden()
        .children(runs.map((r, i) => div().id(`ai-run-${i}`).h_full().flex_none()
          .w(`${Math.max((r.tokens / runTotal) * 100, 0.8)}%`).bg(color.get(r.model) ?? t.dim)
          .tooltip(`${name(r.model)} · ${fmtTokens(r.tokens)} · ${at(r.from)} – ${at(r.to)}`))))
      .child(h_flex().justify_between().text_size(10).text_color(t.dim)
        .child(div().child(at(runs[0].from)))
        .child(div().child(at(runs[runs.length - 1].to)))) : null;

    const legend = v_flex().gap(5).children(models.map(([k, u]) => h_flex().items_center().gap(6)
      .child(swatch(k))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(name(k)))
      .child(div().flex_none().text_size(12).font_bold().child(fmtTokens(u.tokens)))
      .child(div().flex_none().w(34).text_right().text_size(10.5).text_color(t.muted).child(total ? `${Math.round((u.tokens / total) * 100)}%` : ""))
      .child(div().flex_none().w(52).text_right().text_size(10.5).text_color(t.dim).child(cost(u.cost, u.unpriced, d.estimated)))));

    const sideTokens = side.reduce((n, [, u]) => n + u.tokens, 0);
    const sideCost = side.reduce((n, [, u]) => n + (u.cost ?? 0), 0);
    const background = side.length ? div().id("ai-side").text_size(10.5).text_color(t.dim).truncate()
      .tooltip(side.map(([k, u]) => `${name(k)} ${fmtTokens(u.tokens)}`).join("、"))
      .child(`背景呼叫（標題、自動判斷）${fmtTokens(sideTokens)} · ${fmtCost(sideCost)} · ${side.length} 個模型`) : null;

    // The switch log: newest first; long sessions fold to the last five.
    let log = null;
    if (runs.length > 1) {
      const open = this.expanded.has("ai-runs");
      const shown = (open ? runs : runs.slice(-5)).slice().reverse();
      log = v_flex().gap(4).pt(8).border_t(1).border_color(t.border)
        .child(h_flex().justify_between()
          .child(div().text_size(10.5).text_color(t.dim).font_semibold().child(`切換紀錄 · ${runs.length - 1} 次`))
          .when(runs.length > 5, (el) => el.child(div().id("ai-runs").text_size(10.5).text_color(t.dim).cursor_pointer()
            .hover((x) => x.text_color(t.muted)).on_click((_e, cx) => { this.toggle("ai-runs"); cx.notify(); })
            .child(open ? "只看最近 5 段" : `全部 ${runs.length} 段`))))
        .children(shown.map((r) => h_flex().items_center().gap(6)
          .child(swatch(r.model))
          .child(div().flex_none().w(96).text_size(10.5).text_color(t.dim).child(`${at(r.from)}`))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(name(r.model)))
          .child(div().flex_none().text_size(11.5).font_semibold().child(fmtTokens(r.tokens)))));
    }
    return this.card(t, "Tokens", null, head, timeline, legend, background, log);
  }

  // Your last instruction, and the full reply the status block only opens.
  talk(t, m) {
    if (!m.prompt && !m.reply) return null;
    return this.card(t, "最後一輪", null,
      this.para(t, "ai-prompt", "你說", m.prompt, 200),
      this.para(t, "ai-reply", "完整回覆", unmark(m.reply), 280));
  }

  // Everything else, folded: identity, token breakdown, compaction summary.
  details(t, d) {
    const m = d.main, tok = m.tok ?? {};
    const open = this.expanded.has("ai-details");
    const box = v_flex().gap(8).p(12).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(this.fold(t, "ai-details", "詳細資料", `Session ID、目前模型 ${(m.model ?? "?").split("/").pop()}、token 明細、壓縮摘要`));
    if (!open) return box;
    const copy = div().id("ai-copy-id").flex_none().size(20).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .hover((x) => x.bg(t.hover)).tooltip("複製 Session ID")
      .on_click((_e, cx) => cx.write_to_clipboard(m.id ?? ""))
      .child(svg(`${ICON}/copy.svg`).size(12).text_color(t.muted));
    const small = (text) => div().text_size(10.5).text_color(t.dim).whitespace_normal().child(text);
    const c = m.compaction;
    return box
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_family(MONO).text_color(t.muted).child(m.id ?? "?"))
        .child(copy))
      .child(this.line(t, "模型", m.model ?? "?"))
      .child(this.line(t, "開始", m.started ? `${when(m.started)}（${ago(m.started)} 前）` : "?"))
      .child(this.line(t, "指令 / 回覆", `${m.prompts ?? 0} / ${m.replies ?? 0}`))
      .child(this.line(t, "工具失敗", `${m.toolErrors ?? 0} 次`))
      .child(small(`tokens：輸入 ${fmtTokens(tok.input)} · 輸出 ${fmtTokens(tok.output)} · cache 讀 ${fmtTokens(tok.cacheRead)} · cache 寫 ${fmtTokens(tok.cacheWrite)}（cache 每輪重讀，累計不等於上下文）`))
      .when(d.estimated, (el) => el.child(small("花費依 agent 所在機器的模型價目估算，非帳單；缺價目顯示 —")))
      .when(Boolean(m.limits), (el) => el.child(small(`Codex 配額：5h ${m.limits.primary?.used_percent ?? "—"}% · 週 ${m.limits.secondary?.used_percent ?? "—"}%`)))
      .when(Boolean(m.aux), (el) => el.child(small(`其中背景呼叫（標題、自動判斷）${fmtCost(m.aux)}`)))
      .child(c
        ? v_flex().gap(4)
          .child(small(`壓縮 ${m.compactions} 次 · 最近 ${when(c.at)} · ${fmtTokens(c.before)} → ${fmtTokens(c.after)}`))
          .child(c.summary
            ? this.para(t, "ai-summary", c.short && c.short !== "Remote compaction" ? c.short : "壓縮摘要", c.summary, 400)
            : small(`${c.short ?? "壓縮"}：供應商端壓縮，沒有留下文字摘要`))
        : small("還沒壓縮過上下文"));
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
    if (!d.subs.length) return null;
    const c = d.counts;
    const tally = [c.running && `${c.running} 執行中`, c.done && `${c.done} 完成`, c.stopped && `${c.stopped} 中斷`, c.unknown && `${c.unknown} 未知`].filter(Boolean).join(" · ");
    return v_flex().gap(6).p(12).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(this.fold(t, "ai-subs", `Subagents · ${d.subs.length}`, `${tally} · ${cost(d.subCost, d.subs.some((s) => s.unpriced), d.estimated)}`))
      .when(this.expanded.has("ai-subs"), (el) => el.child(v_flex().children(d.subs.flatMap((s) => this.subRow(t, s)))));
  }

  render(cx) {
    const t = theme();
    const a = this.target();
    // A new focused agent, or the panel just opened on stale numbers: read now, not at the next tick.
    if (visible() && (a?.address !== this.address || Date.now() - this.at > POLL_MS)) this.refresh(cx);
    const frame = v_flex().id("agent-info").size_full().bg(t.background).text_color(t.foreground).text_size(12)
      .child(this.header(t, a));
    const note = (text) => frame.child(div().p(16).text_size(12).text_color(t.dim).whitespace_normal().child(text));
    if (!a) return note("先點一個 agent 的 pane，這裡會顯示它的狀態、進度與產出。");
    if (!kindOf(a)) return note(`不支援這個 agent：${a.program?.name ?? a.app ?? "未知"}。`);
    if (this.error) return note(ERRORS[this.error] ?? `讀取失敗：${this.error}`);
    const d = this.data;
    if (!d) return note("讀取中…");
    return frame.child(v_flex().id("ai-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
      .child(this.hero(t, d, a))
      .child(this.stats(t, d))
      .children([this.tasks(t, d.main, a), this.output(t, d.main), this.usage(t, d), this.talk(t, d.main), this.subagents(t, d)].filter(Boolean))
      .child(this.details(t, d)));
  }
}
