import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, theme, settings, notify } from "herdr";
import { checksState, mergeBlocker, parseDiff, relativeTime } from "./pr.js";

const POLL_MS = 30000; // gh talks to the network: poll gently
const LIST_FIELDS = "number,title,author,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,updatedAt,state";
const VIEW_FIELDS = `${LIST_FIELDS},body,url,additions,deletions,changedFiles,reviewDecision,headRefOid`;
const STATES = [["open", "Open"], ["merged", "Merged"], ["closed", "Closed"]];
const METHODS = [["merge", "Merge commit"], ["squash", "Squash"], ["rebase", "Rebase"]];
const MAX_DIFF_ROWS = 5000;

// Same "where is the user" rule as the Changes panel: the focused pane's folder.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

export default class PrPanel extends View {
  init(_props, cx) {
    this.prs = []; this.state = "open"; this.pr = null; this.files = []; this.file = 0; this.rows = []; this.diffWidth = 0;
    this.mergeOpen = false; this.merging = false; this.note = null;
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => { if (!this.pr) this.refresh(cx); });
  }

  gh(args) { return exec("gh", args, { cwd: this.root, on: this.on }); }

  resetContext(context) {
    this.context = context; this.root = null; this.prs = []; this.pr = null; this.files = []; this.rows = [];
    this.error = null; this.note = null; this.mergeOpen = false;
  }

  async ensureRoot(cwd, on, context) {
    if (this.root) return true;
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (key() !== context) return false;
    if (top.code !== 0) { this.error = "Not a git repository"; return false; }
    this.root = top.stdout.trim(); this.on = on; this.error = null;
    return true;
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) this.resetContext(context);
    if (!cwd) { this.error = "No folder"; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!(await this.ensureRoot(cwd, on, context))) return;
        const r = await this.gh(["pr", "list", "--state", this.state, "--limit", "50", "--json", LIST_FIELDS]);
        if (key() !== context) return;
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        this.prs = JSON.parse(r.stdout); this.error = null;
      } catch (e) { if (key() === context) this.error = String(e).replace(/^Error: /, ""); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  setState(state, cx) { this.state = state; this.prs = []; this.refresh(cx); cx.notify(); }

  open(number, cx) {
    this.pr = { number }; this.files = []; this.rows = []; this.file = 0; this.note = null; this.mergeOpen = false; this.detailError = null;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        const [v, d] = await Promise.all([this.gh(["pr", "view", String(number), "--json", VIEW_FIELDS]), this.gh(["pr", "diff", String(number)])]);
        if (this.pr?.number !== number || this.context !== context) return;
        if (v.code !== 0) throw new Error((v.stderr || v.stdout).trim());
        this.pr = JSON.parse(v.stdout);
        if (d.code !== 0) this.detailError = (d.stderr || d.stdout).trim();
        else { this.files = parseDiff(d.stdout); this.pickFile(0); }
      } catch (e) { if (this.pr?.number === number) this.detailError = String(e).replace(/^Error: /, ""); }
      cx.notify();
    });
    cx.notify();
  }

  back(cx) { this.pr = null; this.files = []; this.rows = []; this.mergeOpen = false; this.note = null; this.refresh(cx); cx.notify(); }

  pickFile(i) {
    this.file = i;
    const rows = this.files[i]?.rows ?? [];
    this.rows = rows.length > MAX_DIFF_ROWS ? [...rows.slice(0, MAX_DIFF_ROWS), { kind: "@", text: `Diff truncated at ${MAX_DIFF_ROWS} lines` }] : rows;
    let longest = 0;
    for (const r of this.rows) if (r.text.length > longest) longest = r.text.length;
    this.diffWidth = Math.min(longest, 400) * 7.5 + 90;
  }

  merge(method, cx) {
    if (this.merging || !this.pr) return;
    const pr = this.pr, context = this.context;
    this.merging = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        // --match-head-commit: refuse to merge if the branch moved since this view loaded.
        const r = await this.gh(["pr", "merge", String(pr.number), `--${method}`, "--match-head-commit", pr.headRefOid]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        notify({ title: `PR #${pr.number} merged`, body: pr.title, level: "success" });
        if (this.context === context && this.pr?.number === pr.number) { this.mergeOpen = false; this.open(pr.number, cx); }
      } catch (e) { this.note = `Merge failed: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.merging = false; cx.notify(); }
    });
    cx.notify();
  }

  openOnGithub() { if (this.pr?.url && !this.on) exec("open", [this.pr.url]); }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  checkDot(state, t) {
    const color = { pass: t.ansi2, fail: t.ansi1, pending: t.ansi3 }[state];
    return color ? div().size(8).rounded(4).flex_none().bg(color) : null;
  }

  button(t, id, label, onClick, { primary = false, disabled = false } = {}) {
    return div().id(id).h(28).px(12).flex().items_center().flex_none().rounded(7).text_size(13)
      .bg(disabled ? t.raised : primary ? t.solid : t.raised).text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover)).on_click(onClick)).child(label);
  }

  header(t, cx) {
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Pull Requests"))
      .child(div().flex_1())
      .children(STATES.map(([id, label]) => div().id(`prs-${id}`).h(26).px(8).flex().items_center().rounded(6).text_size(13).cursor_pointer()
        .bg(this.state === id ? t.selected : t.background).text_color(this.state === id ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setState(id, cx)).child(label)))
      .child(div().id("prs-refresh").h(26).px(8).flex().items_center().rounded(6).text_size(13).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx)).child("↻"));
  }

  listView(t, cx) {
    return v_flex().id("prs-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .children(this.prs.map((p) => {
        const ck = checksState(p.statusCheckRollup);
        return v_flex().id(`pr-${p.number}`).flex_none().px(10).py(6).gap(2).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(p.number, cx))
          .child(h_flex().gap(8).items_center()
            .child(div().flex_none().text_color(t.dim).child(`#${p.number}`))
            .child(div().flex_1().min_w(0).truncate().child(p.title))
            .when(p.isDraft, (e) => e.child(div().flex_none().text_size(11).px(5).rounded(4).border_1().border_color(t.border).text_color(t.muted).child("Draft")))
            .when(Boolean(this.checkDot(ck, t)), (e) => e.child(this.checkDot(ck, t))))
          .child(h_flex().gap(6).text_size(12).text_color(t.dim)
            .child(div().min_w(0).truncate().child(`${p.headRefName} → ${p.baseRefName}`))
            .child(div().flex_none().child(`· ${p.author?.login ?? "?"} · ${relativeTime(p.updatedAt)}`))
            .when(p.mergeable === "CONFLICTING", (e) => e.child(div().flex_none().text_color(t.ansi1).child("· conflicts"))));
      }))
      .when(!this.prs.length, (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim)
        .child(this.error || (this.loading ? "Loading pull requests…" : `No ${this.state} pull requests`))));
  }

  mergeBar(t, pr, ck) {
    const blocked = mergeBlocker(pr, ck);
    if (pr.state !== "OPEN") return null;
    return v_flex().flex_none().gap(6).px(12).py(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(this.button(t, "pr-merge", this.mergeOpen ? "Cancel" : "Merge…", (_e, cx) => { this.mergeOpen = !this.mergeOpen; this.note = null; cx.notify(); },
          { primary: !this.mergeOpen, disabled: Boolean(blocked) || this.merging }))
        .when(Boolean(blocked), (e) => e.child(div().text_size(12).text_color(t.ansi3).child(blocked)))
        .when(this.merging, (e) => e.child(div().text_size(12).text_color(t.dim).child("Merging…"))))
      .when(this.mergeOpen && !blocked, (e) => e.child(v_flex().gap(6)
        .child(div().text_size(12).text_color(t.muted).child(`Merge #${pr.number} into ${pr.baseRefName}? Pick a method to confirm:`))
        .child(h_flex().gap(6).children(METHODS.map(([m, label]) => this.button(t, `pr-m-${m}`, label, (_e, cx) => this.merge(m, cx), { disabled: this.merging }))))))
      .when(Boolean(this.note), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.note)));
  }

  detailView(t, cx) {
    const pr = this.pr, ck = checksState(pr.statusCheckRollup), loaded = pr.title !== undefined;
    const stateColor = { OPEN: t.ansi2, MERGED: t.ansi5, CLOSED: t.ansi1 }[pr.state] ?? t.muted;
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.button(t, "pr-back", "‹ Back", (_e, cx) => this.back(cx)))
        .child(div().text_color(t.dim).child(`#${pr.number}`))
        .when(loaded, (e) => e.child(div().px(6).rounded(4).border_1().border_color(stateColor).text_size(12).text_color(stateColor).child(pr.isDraft ? "DRAFT" : pr.state)))
        .child(div().flex_1())
        .when(loaded && !this.on, (e) => e.child(this.button(t, "pr-gh", "GitHub ↗", () => this.openOnGithub()))))
      .when(!loaded, (e) => e.child(div().p(12).text_color(this.detailError ? t.ansi1 : t.dim).child(this.detailError || "Loading…")))
      .when(loaded, (e) => e
        .child(v_flex().flex_none().px(12).py(8).gap(3).border_b(1).border_color(t.border)
          .child(div().font_semibold().child(pr.title))
          .child(h_flex().gap(8).items_center().text_size(12).text_color(t.dim)
            .child(div().min_w(0).truncate().child(`${pr.headRefName} → ${pr.baseRefName} · ${pr.author?.login ?? "?"}`))
            .when(Boolean(this.checkDot(ck, t)), (e) => e.child(this.checkDot(ck, t)).child(div().flex_none().child(`checks ${ck}`)))
            .child(div().flex_none().text_color(t.ansi2).child(`+${pr.additions}`)).child(div().flex_none().text_color(t.ansi1).child(`−${pr.deletions}`))))
        .when(Boolean(pr.body?.trim()), (e) => e.child(div().id("pr-body").flex_none().max_h(90).overflow_y_scrollbar().px(12).py(6).text_size(13).text_color(t.muted).border_b(1).border_color(t.border).child(pr.body.trim())))
        .child(this.mergeBar(t, pr, ck) ?? div())
        .when(Boolean(this.detailError), (e) => e.child(div().p(12).text_color(t.ansi1).child(this.detailError)))
        .child(v_flex().id("pr-files").flex_none().max_h(150).overflow_y_scrollbar().p(4).border_b(1).border_color(t.border)
          .children(this.files.map((f, i) => h_flex().id(`pr-f-${i}`).h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(this.file === i, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.pickFile(i); cx.notify(); })
            .child(div().flex_1().min_w(0).truncate().text_size(13).child(f.path))
            .when(f.binary, (e) => e.child(div().text_size(12).text_color(t.dim).child("binary")))
            .when(f.add > 0, (e) => e.child(div().text_size(12).text_color(t.ansi2).child(`+${f.add}`)))
            .when(f.del > 0, (e) => e.child(div().text_size(12).text_color(t.ansi1).child(`−${f.del}`))))))
        .child(div().flex_1().min_h(0).relative().font_family(mono).text_size(12)
          .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("pr-diff", this.rows.length, 20, (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
          .child(Scrollbar.vertical("pr-diff").viewport_from_layout().absolute().inset_0())));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    return v_flex().id("pr-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(14)
      .child(this.pr ? this.detailView(t, cx) : v_flex().flex_1().min_h(0).child(this.header(t, cx)).child(this.listView(t, cx)));
  }
}
