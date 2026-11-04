import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec } from "herdr";

// Semantic palette derived directly from the user's Herdr theme tokens (`herdr-max` style).
export function primer(t) {
  return {
    open: t.ansi2,
    done: t.ansi5,
    closed: t.ansi1,
    neutral: t.muted,
    attention: t.ansi3,
    link: t.accent,
    nav: t.accent,
    button: t.solid,
    buttonHover: t.accent,
    buttonFg: t.solid_foreground ?? "#ffffff",
  };
}

export const icon = (name) => `mods/github/icons/${name}.svg`;
export const glyph = (name, size, color) => svg(icon(name)).size(size).flex_none().text_color(color);
export const spinner = (size, color) => svg("mods/workspace-chrome/spinner.svg").size(size).flex_none().text_color(color).spin(900);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// GitHub's relative time: "3h ago" this month, "on Sep 21" before.
export function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return `on ${day(iso)}`;
}
export function day(iso) {
  const d = new Date(iso), year = d.getFullYear() === new Date().getFullYear() ? "" : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}
export function duration(from, to) {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function openUrl(url) {
  exec("sh", ["-c", 'xdg-open "$1" >/dev/null 2>&1 &', "sh", url]).catch(() => exec("open", [url]).catch(() => null));
}

// State icon and color of an issue, pull request or workflow run.
export function issueState(i, p) {
  const s = String(i.state ?? "").toUpperCase(), reason = String(i.stateReason ?? "").toUpperCase();
  if (s === "OPEN") return ["issue-open", p.open, "Open"];
  return reason === "NOT_PLANNED" ? ["issue-skip", p.neutral, "Closed"] : ["issue-done", p.done, "Closed"];
}
export function prState(pr, p) {
  const s = String(pr.state ?? "").toUpperCase();
  if (s === "MERGED" || pr.mergedAt) return ["pr-merged", p.done, "Merged"];
  if (s === "CLOSED") return ["pr-closed", p.closed, "Closed"];
  if (pr.isDraft) return ["pr-draft", p.neutral, "Draft"];
  return ["pr-open", p.open, "Open"];
}
export function runState(r, p) {
  const c = String(r.conclusion ?? "").toLowerCase(), s = String(r.status ?? "").toLowerCase();
  if (s && s !== "completed") return s === "in_progress" ? ["spin", p.attention, "In progress"] : ["clock", p.attention, "Queued"];
  if (c === "success") return ["check-circle", p.open, "Success"];
  if (c === "failure" || c === "timed_out" || c === "startup_failure") return ["x-circle", p.closed, "Failure"];
  if (c === "cancelled") return ["skip", p.neutral, "Cancelled"];
  if (c === "skipped" || c === "neutral") return ["skip", p.neutral, "Skipped"];
  return ["dot", p.neutral, c || "Unknown"];
}
// One summary of a PR's checks: failing beats pending beats passing.
export function checksOf(pr) {
  const runs = (pr.statusCheckRollup ?? []).map((c) => ({
    name: c.name ?? c.context, workflow: c.workflowName,
    status: c.__typename === "StatusContext" ? (c.state === "PENDING" ? "in_progress" : "completed") : c.status,
    conclusion: c.__typename === "StatusContext" ? (c.state === "SUCCESS" ? "success" : c.state === "PENDING" ? null : "failure") : c.conclusion,
    url: c.detailsUrl ?? c.targetUrl,
  }));
  const failed = runs.filter((r) => /failure|timed_out|cancelled|action_required|startup_failure/i.test(r.conclusion ?? ""));
  const pending = runs.filter((r) => String(r.status ?? "").toLowerCase() !== "completed");
  return { runs, failed, pending, state: !runs.length ? null : failed.length ? "failure" : pending.length ? "pending" : "success" };
}
export function glyphOf(kind, size, color, t) {
  return kind === "spin" ? spinner(size, color) : glyph(kind, size, color);
}

// A label chip using herdr-max's clean rounded-5 tag style.
export function labelChip(l, t, small = false) {
  const c = (l.color ?? "888888").replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.35;
  return div().h(small ? 20 : 22).px(small ? 6 : 8).flex_none().flex().items_center().rounded(5).border_1().border_color(`#${c}66`).bg(`#${c}26`)
    .text_size(small ? 11.5 : 12.5).font_medium().text_color(light ? `#${c}` : t.foreground).child(l.name);
}

// Where the last button was pressed (window px): a menu it opens hangs under it, not at a pointer
// that may have moved while the menu's content loaded.
let pressed = null;
export function under(width, gap = 4) {
  return pressed ? { x: Math.max(4, pressed.x + pressed.width - width), y: pressed.y + pressed.height + gap } : "pointer";
}

// Buttons styled to match herdr-max controls (theme solid / raised / hover).
export function button(id, label, t, onClick, { primary = false, invisible = false, enabled = true, icon: name = null, tint = null, small = false, tooltip = null } = {}) {
  const p = primer(t), solid = primary && enabled, h = small ? 28 : 32;
  const fg = solid ? p.buttonFg : enabled ? (invisible ? t.muted : t.foreground) : t.dim;
  return h_flex().id(id).h(h).px(label === "" ? (small ? 7 : 9) : (small ? 10 : 13)).gap(6).flex_none().items_center().justify_center().rounded(7)
    .text_size(small ? 12.5 : 13.5).font_medium()
    .bg(solid ? p.button : invisible ? "#00000000" : t.raised).border_1().border_color(solid ? p.button : invisible ? "#00000000" : t.border)
    .text_color(fg)
    .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (e.bounds) pressed = e.bounds; })
    .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(solid ? p.buttonHover : t.hover).text_color(solid ? p.buttonFg : t.foreground)).on_click(onClick))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .when(Boolean(name), (e) => e.child(name === "spin" ? spinner(14, t.muted) : glyph(name, 14, tint ?? fg)))
    .when(label !== "", (e) => e.child(label));
}

// Counter pill matching git-graph / changes count badges.
export const counter = (n, t, on = false) => div().h(19).min_w(19).px(6).flex_none().flex().items_center().justify_center().rounded(5)
  .border_1().border_color(on ? t.accent : t.border)
  .bg(on ? t.selected : t.raised).text_size(11.5).font_medium().text_color(on ? t.foreground : t.muted).child(String(n));

// Segmented control.
export function segmented(id, items, value, t, onPick) {
  return h_flex().id(id).flex_none().h(30).p(2).gap(2).rounded(7).bg(t.raised).border_1().border_color(t.border)
    .children(items.map(([key, label]) => {
      const on = key === value;
      return h_flex().id(`${id}-${key}`).h_full().px(10).gap(5).items_center().rounded(5).text_size(13).cursor_pointer()
        .bg(on ? t.selected : "#00000000").when(on, (e) => e.border_1().border_color(t.border).font_semibold())
        .text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => onPick(key, cx)).child(label);
    }));
}

// Blankslate empty state.
export function blankslate(t, { icon: name, title, body, actions = [], code = null, tone = null }) {
  return v_flex().flex_none().w_full().items_center().px(28).py(36).gap(10)
    .child(div().size(42).mb(4).rounded(10).flex().items_center().justify_center().bg(t.raised).border_1().border_color(t.border)
      .child(name === "spin" ? spinner(18, t.muted) : glyph(name, 18, tone ?? t.muted)))
    .child(div().text_size(15).font_semibold().text_color(t.foreground).text_center().child(title))
    .when(Boolean(body), (e) => e.child(div().max_w(310).text_size(13).text_color(t.muted).text_center().child(body)))
    .when(Boolean(code), (e) => e.child(div().mt(4).px(10).py(6).rounded(6).bg(t.raised).border_1().border_color(t.border)
      .font_family("JetBrains Mono").text_size(12.5).text_color(t.foreground).child(code)))
    .when(actions.length > 0, (e) => e.child(h_flex().mt(8).gap(8).flex_wrap().justify_center().children(actions)));
}

// Skeleton loading bars.
export function skeleton(t, rows = 6) {
  return v_flex().flex_none().p(12).gap(18).children(Array.from({ length: rows }, (_, n) => h_flex().gap(10).items_start()
    .child(div().size(16).rounded(8).bg(t.raised))
    .child(v_flex().flex_1().gap(7)
      .child(div().h(12).w(`${88 - (n * 13) % 40}%`).rounded(4).bg(t.raised))
      .child(div().h(10).w(`${42 - (n * 7) % 18}%`).rounded(4).bg(t.raised)))));
}

// Small pill badge ("Owner", "bot", "Draft").
export const badge = (label, t, color = null) => div().h(20).px(7).flex_none().flex().items_center().rounded(5).border_1()
  .border_color(color ? `${color}66` : t.border).text_size(12).font_medium().text_color(color ?? t.muted).child(label);
