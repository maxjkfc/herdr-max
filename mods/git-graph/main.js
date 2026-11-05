import { View, div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, theme, run, shared, nextCommand, openOverlay, closeOverlay, props } from "herdr";
import { layoutGraph, parseLog, relativeTime, LOG_FORMAT } from "./graph.js";
import { CommitDialog } from "./commit.js";

const ROW = 32;        // px per commit row
const LANE = 16;       // px per graph lane
const MAX_LANES = 12;  // wider graphs are clipped, the commit text keeps its room
const LIMIT = 500;     // newest commits loaded
const POLL_MS = 6000;
// Reads write nothing under .git, so polling never feeds a folder watcher.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

// Same "where is the user" rule as the Changes panel: the focused pane's folder.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

const pad = (n) => String(n).padStart(2, "0");
function fullDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function segPath(s) {
  s.path ??= (() => {
    const x1 = s.x1 * LANE + LANE / 2, x2 = s.x2 * LANE + LANE / 2, y1 = s.y1 * ROW, y2 = s.y2 * ROW;
    const b = PathBuilder.stroke(2).move_to(x1, y1);
    if (x1 === x2) b.line_to(x2, y2);
    else { const my = (y1 + y2) / 2; b.cubic_bezier_to(x2, y2, x1, my, x2, my); }
    return b.build();
  })();
  return s.path;
}

export default class GitGraph extends View {
  init(_props, cx) {
    // The right-click menu and the details dialog are this mod opened as overlays, told which by props.
    const pr = props() ?? {};
    if (pr.commit) { this.dialog = new CommitDialog(pr.commit, pr.overlay, cx); return; }
    if (pr.menu) { this.menu = { ...pr.menu, overlay: pr.overlay }; return; }
    this.commits = []; this.graph = { rows: [], width: 1 };
    this.all = localStorage.getItem("all") !== "0";
    this.selected = null; this.detail = null;
    this.handle = cx.focus_handle();
    this.focusAt = shared("git.focus")?.at;
    this.refresh(cx, true);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx, false));
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") { this.handle.focus(); cx.notify(); }
        else if (cmd === "down") this.step(1, cx);
        else if (cmd === "up") this.step(-1, cx);
      }
    });
  }

  step(delta, cx) {
    if (!this.commits.length) return;
    const cur = this.commits.findIndex((c) => c.hash === this.selected);
    const next = cur < 0 ? 0 : (cur + delta + this.commits.length) % this.commits.length;
    this.selected = null;
    this.select(this.commits[next].hash, cx);
  }

  onKey(e, cx) {
    const k = e.key;
    if (k === "j" || k === "down" || ((k === "j" || k === "n") && e.modifiers?.control)) {
      this.step(1, cx); cx.stop_propagation();
    } else if (k === "k" || k === "up" || ((k === "k" || k === "p") && e.modifiers?.control)) {
      this.step(-1, cx); cx.stop_propagation();
    } else if (k === "a") {
      this.toggleScope(cx); cx.stop_propagation();
    } else if (k === "r") {
      this.refresh(cx, true); cx.stop_propagation();
    } else if (k === "escape" && this.selected) {
      this.selected = null; this.detail = null; cx.stop_propagation(); cx.notify();
    } else if (k === "escape" || k === "q") {
      run("pane.go", { direction: "left" });
      run("layout.hide", { id: "panel" });
      cx.stop_propagation();
    } else if (k === "h" || k === "left") {
      run("pane.go", { direction: "left" });
      cx.stop_propagation();
    }
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }

  refresh(cx, force) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.sig = null; force = true;
      this.commits = []; this.graph = { rows: [], width: 1 }; this.selected = null; this.detail = null; this.error = null;
    }
    if (!cwd) { this.error = "No folder"; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (key() !== context) return;
          if (top.code !== 0) { this.error = "Not a git repository"; return; }
          this.root = top.stdout.trim(); this.on = on; this.error = null;
        }
        const refs = await this.git(["show-ref", "--head"]);
        const sig = `${this.all}\n${refs.stdout}`;
        if (key() !== context) return;
        if (!force && sig === this.sig) return;
        const scope = this.all ? ["--branches", "--remotes", "--tags", "HEAD"] : ["HEAD"];
        const log = await this.git(["log", ...scope, "--date-order", "-n", String(LIMIT), "--decorate=short", `--format=${LOG_FORMAT}`]);
        if (key() !== context) return;
        // An unborn branch has no HEAD to log: that is an empty graph, not a failure.
        if (log.code !== 0 && !/does not have any commits|unknown revision|bad default revision/.test(log.stderr)) throw new Error(log.stderr.trim());
        this.commits = log.code === 0 ? parseLog(log.stdout) : [];
        this.graph = layoutGraph(this.commits);
        this.sig = sig; this.error = null;
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  select(hash, cx) {
    this.selected = this.selected === hash ? null : hash;
    this.detail = null;
    if (this.selected) {
      const context = this.context;
      cx.spawn(async (cx) => {
        try {
          const [msg, files] = await Promise.all([
            this.git(["show", "-s", "--format=%B", hash]),
            // First-parent diff for merges, root diff for the first commit.
            this.git(["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "--root", "-m", "--first-parent", hash]),
          ]);
          if (this.selected !== hash || this.context !== context) return;
          this.detail = {
            body: msg.stdout.trim().split("\n").slice(1).join("\n").trim(),
            files: files.stdout.split("\n").filter(Boolean).map((l) => { const [s, ...p] = l.split("\t"); return { status: s[0], path: p[p.length - 1] }; }),
          };
        } catch (e) { if (this.selected === hash) this.detail = { error: String(e), files: [], body: "" }; }
        cx.notify();
      });
    }
    cx.notify();
  }

  toggleScope(cx) {
    this.all = !this.all;
    localStorage.setItem("all", this.all ? "1" : "0");
    this.refresh(cx, true);
    cx.notify();
  }

  chip(ref, t) {
    const color = { head: t.accent, branch: t.ansi2, remote: t.ansi4, tag: t.ansi3 }[ref.kind];
    const solid = ref.kind === "head";
    return div().h(19).px(6).flex().items_center().flex_none().max_w(130).truncate().rounded(4).text_size(12)
      .border_1().border_color(color).when(solid, (e) => e.bg(t.accent).text_color(t.accent_foreground)).when(!solid, (e) => e.text_color(color))
      .child(ref.name);
  }

  row(r, palette, t) {
    const lanes = Math.min(this.graph.width, MAX_LANES), c = palette[r.color % palette.length];
    const refs = [...r.commit.refs].sort((a, b) => (a.kind === "head" ? -1 : 0) - (b.kind === "head" ? -1 : 0));
    const cell = div().w(lanes * LANE).h(ROW).flex_none().relative().overflow_hidden()
      .children(r.segs.map((s) => window.paint_path(segPath(s), palette[s.color % palette.length]).absolute().top(0).left(0).size_full()))
      .child(div().absolute().top(ROW / 2 - (r.merge ? 7 : 6)).left(r.node * LANE + LANE / 2 - (r.merge ? 7 : 6)).size(r.merge ? 14 : 12).rounded(r.merge ? 7 : 6)
        .border_2().border_color(c).bg(r.merge ? t.background : c).flex().items_center().justify_center()
        .when(r.merge, (e) => e.child(div().size(4).rounded(2).bg(c))));
    const sel = this.selected === r.commit.hash;
    return h_flex().id(`gg-${r.commit.hash}`).w_full().h(ROW).flex_none().items_center().gap(6).pr(10).cursor_pointer()
      .when(sel, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(cell)
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .children(refs.slice(0, 3).map((ref) => this.chip(ref, t)))
        .when(refs.length > 3, (e) => e.child(div().flex_none().text_size(12).text_color(t.dim).child(`+${refs.length - 3}`)))
        .child(div().flex_1().min_w(0).truncate().child(r.commit.subject)))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(relativeTime(r.commit.time)));
  }

  detailView(t) {
    const commit = this.commits.find((c) => c.hash === this.selected);
    if (!commit) return null;
    const d = this.detail, color = { A: t.ansi2, D: t.ansi1, M: t.blocked, R: t.ansi4, C: t.ansi4 };
    return v_flex().id("gg-detail").flex_none().max_h(260).overflow_y_scrollbar().p(12).gap(4).border_t(1).border_color(t.border)
      .child(div().font_semibold().child(commit.subject))
      .child(div().text_size(13).text_color(t.dim).child(`${commit.hash.slice(0, 10)} · ${commit.author} · ${fullDate(commit.time)}`))
      .when(commit.parents.length > 1, (e) => e.child(div().text_size(13).text_color(t.dim).child(`merge of ${commit.parents.map((p) => p.slice(0, 7)).join(" + ")}`)))
      .when(Boolean(d?.body), (e) => e.child(div().text_size(14).text_color(t.muted).child(d.body)))
      .when(!d, (e) => e.child(div().text_size(13).text_color(t.dim).child("Loading…")))
      .when(Boolean(d?.error), (e) => e.child(div().text_size(13).text_color(t.ansi1).child(d.error)))
      .children((d?.files ?? []).slice(0, 100).map((f) => h_flex().gap(8).text_size(13).h(22).flex_none()
        .child(div().w(14).flex_none().text_color(color[f.status] ?? t.muted).child(f.status))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(f.path))))
      .when((d?.files.length ?? 0) > 100, (e) => e.child(div().text_size(13).text_color(t.dim).child(`…and ${d.files.length - 100} more files`)));
  }

  // Right-click on a commit row: a small menu at the pointer.
  openMenu(hash) {
    const commit = this.commits.find((c) => c.hash === hash);
    if (!commit || !this.root) return;
    openOverlay({ mod: "git-graph", kind: "popup", width: 210, height: 4 * 2 + 3 * 34, at: "pointer", props: { menu: { commit, root: this.root, on: this.on } } });
  }

  renderMenu(t) {
    const m = this.menu;
    const item = (id, label, hint, on_click) => h_flex().id(id).h(34).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(on_click)
      .child(div().flex_1().text_size(13).child(label)).child(div().text_size(11).text_color(t.dim).child(hint));
    const copy = (text) => (_e, cx) => { cx.write_to_clipboard(text); closeOverlay(m.overlay); };
    return v_flex().id("gg-menu").size_full().p(4).bg(t.popover).text_color(t.foreground)
      .child(item("gg-m-detail", "顯示詳細資訊", "", () => {
        openOverlay({ mod: "git-graph", kind: "dialog", width: 0.88, height: 0.92, props: { commit: { commit: m.commit, root: m.root, on: m.on } } });
        closeOverlay(m.overlay);
      }))
      .child(item("gg-m-hash", "複製完整 Hash", m.commit.hash.slice(0, 7), copy(m.commit.hash)))
      .child(item("gg-m-subject", "複製標題", "", copy(m.commit.subject)));
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    if (this.menu) return this.renderMenu(theme());
    if (key() !== this.context) this.refresh(cx, true);
    const focusReq = shared("git.focus");
    if (focusReq?.at && focusReq.at !== this.focusAt && focusReq.target === "graph") {
      this.focusAt = focusReq.at;
      cx.timer.after(40, () => this.handle.focus());
    }
    const t = theme(), rows = this.graph.rows;
    const palette = [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.accent, t.ansi1];
    const button = (id, label, on_click) => div().id(id).h(26).px(8).flex().items_center().rounded(6).text_size(13).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(on_click).child(label);
    return v_flex().id("git-graph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(15).track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Graph"))
        .child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(`${rows.length}${rows.length >= LIMIT ? "+" : ""} commits`))
        .child(div().flex_1())
        .child(button("gg-scope", this.all ? "All branches" : "HEAD only", (_e, cx) => this.toggleScope(cx)))
        .child(button("gg-refresh", "↻", (_e, cx) => this.refresh(cx, true))))
      .child(div().flex_1().min_h(0).relative()
        .when(rows.length > 0, (e) => e
          .child(v_virtual_list("git-graph-list", rows.length, ROW, (i) => rows[i].commit.hash,
            (range) => rows.slice(range.start, range.end).map((r) => this.row(r, palette, t))).on_item_click((hash, cx) => this.select(hash, cx))
            .on_item_secondary_click((hash, _ev, _cx) => this.openMenu(hash)).size_full())
          .child(Scrollbar.vertical("git-graph-list").viewport_from_layout().absolute().inset_0()))
        .when(rows.length === 0, (e) => e.child(div().p(12).text_color(t.dim)
          .child(this.error || (this.loading ? "Loading graph…" : this.root ? "No commits yet" : "No folder")))))
      .when(Boolean(this.selected) && this.commits.some((c) => c.hash === this.selected), (e) => e.child(this.detailView(t)));
  }
}
