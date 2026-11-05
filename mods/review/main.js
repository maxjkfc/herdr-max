import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, theme, closeOverlay, openOverlay, props, shared, setShared } from "herdr";
import { treeRows } from "./filetree.js";
import { parseDiff } from "./diff.js";
import { diffColors, diffRow, loadPaletteId, nextPaletteId, savePaletteId, syntaxColors, tokenizeRows } from "./diffview.js";
import { askMessage, lineLabel, locate, makeDraft, reviewMessage } from "./drafts.js";
import { SendDialog } from "./send.js";
import { dirtyCount, nameOf, parseWorktrees } from "./worktrees.js";

// Review of a worktree's changes (and the only writes: comment drafts, and the commit box), opened as a dialog from the Git panel's 審查 button with { root, on }.
// Same safe flags as the Changes panel: never take index.lock (an agent's commit may need it), never start
// fsmonitor, never rewrite the index.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MONO = "JetBrains Mono";
const FILE_ROW_H = 28, DIFF_ROW_H = 22, MAX_DIFF_ROWS = 5000;
const PALETTE_KEY = "review.diffPalette", SCOPE_KEY = "review.scopes", DRAFTS_KEY = "review.drafts";
// [id, label, what it compares]
const SCOPES = [
  ["work", "未提交", "工作目錄 vs HEAD"],
  ["last", "最後一個 commit", "HEAD 的上一個 commit → 工作目錄（含未提交）"],
  ["branch", "對 base", "與 base 分支分岔後的全部變更（含未提交）"],
];
// What a scope means, for the message an agent gets.
const SCOPE_WORDS = { work: "working tree vs HEAD", last: "the last commit plus uncommitted changes", branch: "everything since the branch left its base, plus uncommitted changes" };

const remembered = () => { try { return JSON.parse(localStorage.getItem(SCOPE_KEY) ?? "{}"); } catch { return {}; } };

export default class Review extends View {
  init(_props, cx) {
    const pr = props() ?? {};
    // The send dialog (a review, or a question about some lines) is this mod opened as an overlay, told so by props.
    if (pr.send) { this.dialog = new SendDialog(pr.send, pr.overlay, cx); return; }
    Object.assign(this, { root: pr.root, on: pr.on ?? null, overlay: pr.overlay });
    this.scope = null; this.info = null; this.ref = null;           // info: { branch, base, mergeBase, ahead }
    this.files = []; this.fileIdx = 0; this.rows = []; this.diffWidth = 0;
    this.cache = new Map();                                         // scope|path -> parsed file diff
    this.loading = true; this.loadingFile = false; this.error = null; this.note = null;
    this.collapsed = new Set(); this.filter = ""; this.typing = false;
    this.filterInput = InputState.new({ placeholder: "篩選檔案…" });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value(); cx.notify(); });
    this.filterInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.fileList = VirtualListScrollHandle.new();
    this.paletteId = loadPaletteId(PALETTE_KEY);
    // Review comments: drafts of the shown scope (see list()), the selected lines, the comment box.
    this.drafts = []; this.draftsKey = null; this.marks = new Set(); this.stale = new Set(); this.sel = null; this.editing = null; this.pendingJump = null;
    this.composerText = "";
    this.composerInput = TextareaState.new({ placeholder: "寫下你的意見，Cmd/Ctrl+Enter 加入…" });
    this.composerInput.set_auto_grow(2, 6);
    this.composerInput.on("change", (_e, cx) => { this.composerText = this.composerInput.value(); cx.notify(); });
    this.composerInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.composerInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.composerInput.on("submit", (e, cx) => { if (e.secondary) this.addComment(cx); });
    this.rowList = VirtualListScrollHandle.new();
    this.sentAt = shared("review.sent")?.at;
    // Worktrees of this repo (to look at another one), uncommitted entries here, and the commit box.
    this.worktrees = []; this.dirty = 0; this.message = ""; this.committing = false; this.wtItems = null; this.showMerged = false;
    this.commitInput = InputState.new({ placeholder: "Commit 訊息" });
    this.commitInput.on("change", (_e, cx) => { this.message = this.commitInput.value(); cx.notify(); });
    this.commitInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.commitInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.commitInput.on("submit", (_e, cx) => this.commit(cx));
    cx.timer.after(40, () => this.handle.focus());
    this.refresh(cx, true);
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }
  ok(r) { return r?.code === 0; }

  // Re-reads the repo: where HEAD and the base are, then the file list for the scope.
  refresh(cx, first = false) {
    if (!this.root) { this.error = "沒有指定專案資料夾"; this.loading = false; return; }
    this.loading = true; this.error = null; this.cache.clear();
    cx.spawn(async (cx) => {
      try {
        const top = await this.git(["rev-parse", "--show-toplevel"]);
        if (!this.ok(top)) throw new Error("這裡不是 Git 專案");
        const [branch, head, up] = await Promise.all([
          this.git(["rev-parse", "--abbrev-ref", "HEAD"]), this.git(["rev-parse", "--verify", "HEAD"]),
          this.git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]),
        ]);
        this.hasHead = this.ok(head);
        let base = this.ok(up) ? up.stdout.trim() : null;
        for (const b of base ? [] : ["main", "master"]) if (this.ok(await this.git(["rev-parse", "--verify", "--quiet", b]))) { base = b; break; }
        let mergeBase = null, ahead = 0;
        if (base && this.hasHead) {
          const mb = await this.git(["merge-base", "HEAD", base]);
          if (this.ok(mb)) {
            mergeBase = mb.stdout.trim();
            const n = await this.git(["rev-list", "--count", `${mergeBase}..HEAD`]);
            ahead = this.ok(n) ? Number(n.stdout.trim()) || 0 : 0;
          }
        }
        this.info = { branch: branch.stdout.trim(), base, mergeBase, ahead };
        const [wt, st] = await Promise.all([
          this.git(["worktree", "list", "--porcelain"]),
          this.git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
        ]);
        this.worktrees = this.ok(wt) ? parseWorktrees(wt.stdout) : [];
        this.dirty = this.ok(st) ? dirtyCount(st.stdout) : 0;
        // A branch that has left its base opens against it; the choice is remembered per repo.
        if (first) this.scope = remembered()[`${this.on ?? ""}:${this.root}`] ?? (ahead > 0 ? "branch" : "work");
        await this.loadFiles(cx);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // What the working tree is diffed against for the scope (null = this scope can't be shown).
  async refFor(scope) {
    if (!this.hasHead) return EMPTY_TREE;
    if (scope === "work") return "HEAD";
    if (scope === "last") return this.ok(await this.git(["rev-parse", "--verify", "--quiet", "HEAD~1"])) ? "HEAD~1" : EMPTY_TREE;
    return this.info.mergeBase;
  }

  async loadFiles(cx) {
    this.note = null;
    if (this.scope === "branch" && !this.info.mergeBase) { this.note = "找不到 base 分支（origin/HEAD、main、master），改看未提交的變更"; this.scope = "work"; }
    this.ref = await this.refFor(this.scope);
    const [stat, untracked] = await Promise.all([
      this.git(["diff", this.ref, "--numstat", "-z", "--no-renames"]),
      this.git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    if (!this.ok(stat)) throw new Error(stat.stderr.trim() || "git diff 失敗");
    const files = [];
    for (const rec of stat.stdout.split("\0").filter(Boolean)) {
      const [a, d, ...p] = rec.split("\t");
      files.push({ path: p.join("\t"), add: a === "-" ? 0 : Number(a), del: d === "-" ? 0 : Number(d), binary: a === "-" });
    }
    for (const path of untracked.stdout.split("\0").filter(Boolean)) files.push({ path, add: 0, del: 0, binary: false, untracked: true });
    this.files = files.sort((x, y) => x.path.localeCompare(y.path));
    this.pick(Math.min(this.fileIdx, Math.max(0, this.files.length - 1)), cx);
  }

  setScope(scope, cx) {
    if (scope === this.scope || this.loading) return;
    this.scope = scope; this.fileIdx = 0; this.rows = []; this.loading = true;
    const all = remembered(); all[`${this.on ?? ""}:${this.root}`] = scope;
    try { localStorage.setItem(SCOPE_KEY, JSON.stringify(all)); } catch { /* memory only */ }
    this.cache.clear();
    cx.spawn(async (cx) => {
      try { await this.loadFiles(cx); } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
    cx.notify();
  }

  // Shows file `idx`; its diff is read the first time it is picked.
  pick(idx, cx) {
    this.fileIdx = idx; this.rows = []; this.diffWidth = 0; this.closeComposer();
    const f = this.files[idx];
    if (!f) return;
    const key = `${this.scope}|${f.path}`, hit = this.cache.get(key);
    if (hit) { this.show(f, hit); return; }
    this.loadingFile = true;
    cx.spawn(async (cx) => {
      try {
        // An untracked file has no diff against anything: git compares it with /dev/null (exit 1 = they differ).
        const r = f.untracked
          ? await this.git(["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", f.path])
          : await this.git(["diff", this.ref, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--", f.path]);
        if (r.code > 1 || (r.code === 1 && !f.untracked)) throw new Error(r.stderr.trim() || "git diff 失敗");
        const parsed = parseDiff(r.stdout)[0] ?? { path: f.path, add: 0, del: 0, binary: f.binary, rows: [] };
        if (f.untracked) { f.add = parsed.add; f.binary = parsed.binary; }
        this.cache.set(key, parsed);
        if (this.files[this.fileIdx] === f) this.show(f, parsed);
      } catch (e) { if (this.files[this.fileIdx] === f) this.error = String(e?.message ?? e); }
      finally { this.loadingFile = false; cx.notify(); }
    });
  }

  show(f, parsed) {
    const rows = parsed.rows;
    tokenizeRows(rows, f.path);
    this.rows = rows.length > MAX_DIFF_ROWS ? [...rows.slice(0, MAX_DIFF_ROWS), { kind: "@", text: `Diff truncated at ${MAX_DIFF_ROWS} lines` }] : rows;
    let longest = 0;
    for (const r of this.rows) if (r.text.length > longest) longest = r.text.length;
    this.diffWidth = Math.min(longest, 400) * 8 + 100;
    this.refreshMarks(); this.applyJump();
  }

  // Next / previous file among the rows the tree shows (folders collapsed or filtered away are skipped).
  step(delta, cx) {
    const rows = treeRows(this.files, this.collapsed, this.filter), shown = rows.filter((r) => r.type === "file");
    if (!shown.length) return;
    const next = shown[(shown.findIndex((r) => r.idx === this.fileIdx) + delta + shown.length) % shown.length];
    this.pick(next.idx, cx);
    this.fileList.scroll_to_item(rows.indexOf(next), "center");
  }

  // ---- review comments ----

  draftKey() { return `${this.on ?? ""}:${this.root}|${this.scope}`; }

  // The drafts of the shown repo and scope, read from storage when that changes.
  list() {
    const k = this.draftKey();
    if (this.draftsKey !== k) {
      this.draftsKey = k;
      try { this.drafts = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}")[k] ?? []; } catch { this.drafts = []; }
    }
    return this.drafts;
  }

  saveDrafts() {
    try {
      const all = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}"), k = this.draftKey();
      if (this.list().length) all[k] = this.drafts; else delete all[k];
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
    } catch { /* memory only */ }
  }

  // Rows of the shown file that carry a comment, and the drafts whose lines are gone.
  refreshMarks() {
    this.marks = new Set(); this.stale = new Set();
    const path = this.files[this.fileIdx]?.path;
    for (const d of this.list()) {
      if (d.path !== path) continue;
      const loc = locate(this.rows, d);
      if (loc) for (let i = loc.from; i <= loc.to; i++) this.marks.add(i); else this.stale.add(d.id);
    }
  }

  hunkRange(i) {
    let to = i;
    while (to + 1 < this.rows.length && this.rows[to + 1].kind !== "@") to++;
    return { from: i + 1, to };
  }

  // A click on a diff row: select it (opens the comment box); a click on another row widens a one-line selection;
  // the same row again deselects; a hunk header selects the whole hunk.
  clickRow(i, cx) {
    const row = this.rows[i], s = this.sel;
    if (!row) return;
    if (row.kind === "@") { const h = this.hunkRange(i); this.sel = { from: h.from, to: h.to, anchor: h.from }; }
    else if (s && !this.editing && s.from === s.to && s.anchor === i) { this.closeComposer(); cx.notify(); return; }
    else if (s && !this.editing && s.from === s.to) this.sel = { from: Math.min(s.anchor, i), to: Math.max(s.anchor, i), anchor: s.anchor };
    else this.sel = { from: i, to: i, anchor: i };
    this.composerInput.focus(); cx.notify();
  }

  closeComposer() {
    this.sel = null; this.editing = null; this.composerText = "";
    this.composerInput.set_value("");
  }

  selLabel() {
    const d = this.sel && makeDraft({ id: "", path: "", rows: this.rows, from: this.sel.from, to: this.sel.to, body: "x" });
    return d ? lineLabel(d) : "";
  }

  addComment(cx) {
    const f = this.files[this.fileIdx], body = this.composerText;
    if (!body.trim() || !(this.editing || (f && this.sel))) return;
    if (this.editing) {
      const d = this.list().find((x) => x.id === this.editing);
      if (d) d.body = body.trim();
    } else {
      const d = makeDraft({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, path: f.path, rows: this.rows, from: this.sel.from, to: this.sel.to, body });
      if (!d) return;
      this.list().push(d);
    }
    this.saveDrafts(); this.closeComposer(); this.refreshMarks(); cx.notify();
  }

  deleteDraft(id, cx) {
    this.drafts = this.list().filter((d) => d.id !== id);
    if (this.editing === id) this.closeComposer();
    this.saveDrafts(); this.refreshMarks(); cx.notify();
  }

  // Click on a draft in the list: show its file, scroll to its lines, and open it for editing.
  jumpTo(d, cx) {
    const idx = this.files.findIndex((f) => f.path === d.path);
    if (idx < 0) { this.note = "這則留言的檔案不在這個範圍裡"; cx.notify(); return; }
    this.pendingJump = d.id;
    if (idx === this.fileIdx && this.rows.length) { this.applyJump(); cx.notify(); } else { this.pick(idx, cx); cx.notify(); }
  }

  applyJump() {
    const d = this.pendingJump && this.list().find((x) => x.id === this.pendingJump);
    this.pendingJump = null;
    if (!d) return;
    const loc = locate(this.rows, d);
    this.editing = d.id; this.composerText = d.body; this.composerInput.set_value(d.body);
    if (loc) { this.sel = { from: loc.from, to: loc.to, anchor: loc.from }; this.rowList.scroll_to_item(loc.from, "center"); }
  }

  // The whole review, to one agent (the send dialog picks it).
  submit() {
    const drafts = this.list();
    if (!drafts.length) return;
    const base = this.info?.base ? `, base ${this.info.base}` : "";
    const text = reviewMessage({ root: this.root, on: this.on, scopeWords: `${SCOPE_WORDS[this.scope]}${this.scope === "branch" ? base : ""}`, drafts });
    openOverlay({ mod: "review", kind: "dialog", width: 760, height: 680, props: { send: { title: `送出審查（${drafts.length} 則留言）`, text, ask: false, root: this.root, on: this.on, count: drafts.length } } });
  }

  // Right-click: ask an agent about these lines (the selection if the row is in it, else the row or its hunk).
  askAbout(i) {
    const row = this.rows[i], f = this.files[this.fileIdx], s = this.sel;
    if (!row || !f) return;
    const range = s && i >= s.from && i <= s.to ? s : row.kind === "@" ? this.hunkRange(i) : { from: i, to: i };
    const lines = this.rows.slice(range.from, range.to + 1);
    openOverlay({ mod: "review", kind: "dialog", width: 760, height: 640, props: { send: { title: `問 agent · ${f.path}`, text: askMessage({ root: this.root, on: this.on, path: f.path, rows: lines }), ask: true, root: this.root, on: this.on } } });
  }

  cyclePalette() {
    this.paletteId = nextPaletteId(this.paletteId);
    savePaletteId(PALETTE_KEY, this.paletteId);
  }

  onKey(e, cx) {
    const k = e.key, ctrl = e.modifiers?.control;
    if (this.typing) {
      // Keys belong to the text box; Escape hands the keyboard back to the dialog (and drops an empty new comment).
      if (k === "escape") {
        this.typing = false; this.handle.focus();
        if (this.sel && !this.editing && !this.composerText.trim()) this.closeComposer();
        cx.stop_propagation(); cx.notify();
      }
      return;
    }
    if (k === "escape" || k === "q") closeOverlay(this.overlay);
    else if (k === "j" || k === "down" || (ctrl && k === "n")) this.step(1, cx);
    else if (k === "k" || k === "up" || (ctrl && k === "p")) this.step(-1, cx);
    else if (k === "1" || k === "2" || k === "3") this.setScope(SCOPES[Number(k) - 1][0], cx);
    else if (k === "r") this.refresh(cx);
    else return;
    cx.stop_propagation(); cx.notify();
  }

  // Looking at another worktree of the repo: everything is read again from there, with its own scope and drafts.
  switchTo(root, cx) {
    if (!root || root === this.root) return;
    this.closeComposer();
    Object.assign(this, { root, scope: null, info: null, files: [], rows: [], fileIdx: 0, collapsed: new Set(), marks: new Set(), stale: new Set(), dirty: 0, message: "", note: null });
    this.commitInput.set_value("");
    this.cache.clear();
    this.refresh(cx, true);
  }

  // Is this worktree's work already in the base branch? A normal/fast-forward merge shows as HEAD being an ancestor of
  // base; a squash or rebase merge of a GitHub PR only as a merged PR whose head commit is exactly this HEAD (asked via gh).
  // A worktree sitting on the base tip itself (a fresh branch, or the base branch) has nothing to merge: not "merged".
  async mergedState(w) {
    const base = this.info?.base, o = { cwd: w.path, on: this.on };
    if (!base || !w.branch || w.detached) return false;
    const [head, tip] = await Promise.all([exec("git", [...READ, "rev-parse", "HEAD"], o), exec("git", [...READ, "rev-parse", base], o)]).catch(() => []);
    if (head?.code !== 0 || tip?.code !== 0) return false;
    const sha = head.stdout.trim();
    if (sha === tip.stdout.trim()) return false;
    const anc = await exec("git", [...READ, "merge-base", "--is-ancestor", sha, base], o).catch(() => null);
    if (anc?.code === 0) return true;
    const user = this.on ? null : shared("git-remote.user");
    const args = ["pr", "list", "--head", w.branch, "--state", "merged", "--json", "headRefOid", "--limit", "10"];
    const r = await (user ? exec("sh", ["-c", 'T=$(gh auth token --user "$0") || exit 3; GH_TOKEN=$T exec gh "$@"', user, ...args], o) : exec("gh", args, o)).catch(() => null);
    try { return r?.code === 0 && JSON.parse(r.stdout).some((p) => p.headRefOid === sha); } catch { return false; }
  }

  // The worktree menu: every worktree with its branch, how many uncommitted entries it holds, and whether it is merged
  // (filled in after the list shows: gh can take a moment). It drops from the header inside this dialog; a popup would
  // open at the last pointer position of the main window, not here.
  openWtMenu(cx) {
    if (this.wtItems) { this.wtItems = null; cx.notify(); return; }
    const list = this.worktrees;
    cx.spawn(async (cx) => {
      const items = await Promise.all(list.map(async (w) => {
        const st = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: w.path, on: this.on }).catch(() => null);
        return { path: w.path, branch: w.branch, detached: w.detached, dirty: st?.code === 0 ? dirtyCount(st.stdout) : null, merged: null };
      }));
      this.wtItems = items; cx.notify();
      await Promise.all(items.map(async (w) => { w.merged = await this.mergedState(w); cx.notify(); }));
    });
  }

  renderWtMenu(t) {
    const close = (_e, cx) => { this.wtItems = null; cx.notify(); };
    const items = this.wtItems, nMerged = items.filter((w) => w.merged && w.path !== this.root).length;
    const shown = items.filter((w) => this.showMerged || !w.merged || w.path === this.root);
    const checking = items.some((w) => w.merged === null);
    return v_flex().id("wt-backdrop").absolute().inset_0().pt(46).pl(20).items_start().on_click(close)
      .child(v_flex().id("wt-menu").w(460).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .on_click((_e, cx) => cx.stop_propagation())
        .child(h_flex().flex_none().px(12).pt(10).pb(6).gap(8).items_center()
          .child(div().flex_1().text_size(12.5).font_semibold().child("選擇要審查的 worktree"))
          .when(checking, (e) => e.child(div().text_size(11).text_color(t.dim).child("檢查合併狀態…")))
          .when(nMerged > 0, (e) => e.child(div().id("wt-merged-toggle").px(6).py(2).rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
            .hover((x) => x.bg(t.hover)).on_click((_e, cx) => { this.showMerged = !this.showMerged; cx.notify(); })
            .child(this.showMerged ? `隱藏已合併 (${nMerged})` : `顯示已合併 (${nMerged})`))))
        .child(v_flex().id("wt-list").max_h(300).overflow_y_scrollbar().px(4).pb(6).children(shown.map((w) => {
          const current = w.path === this.root;
          return h_flex().id(`wt-${w.path}`).h(48).flex_none().px(10).gap(10).items_center().rounded(6).cursor_pointer()
            .hover((x) => x.bg(t.hover)).bg(current ? t.selected : "#00000000").when(Boolean(w.merged), (e) => e.opacity(0.55))
            .on_click((_e, cx) => { this.wtItems = null; this.switchTo(w.path, cx); cx.notify(); })
            .child(div().w(14).flex_none().text_color(t.accent).child(current ? "✓" : ""))
            .child(v_flex().flex_1().min_w(0)
              .child(h_flex().gap(8).items_center()
                .child(div().truncate().text_size(13).font_semibold().child(nameOf(w.path)))
                .child(div().flex_none().text_size(11).text_color(t.ansi2).child(w.detached ? "（detached）" : w.branch ?? ""))
                .when(Boolean(w.merged), (e) => e.child(div().flex_none().px(5).rounded(3).text_size(11).text_color(t.ansi5 ?? t.muted).border_1().border_color(t.border).child("已合併")))
                .when(w.dirty > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.working).child(`${w.dirty} 個未提交`))))
              .child(div().truncate().text_size(11).font_family(MONO).text_color(t.dim).child(w.path)));
        }))));
  }

  // Commits everything in this worktree (add -A, commit), like the Changes panel's box.
  commit(cx) {
    const message = this.message.trim(), root = this.root;
    if (!message || this.committing || !this.dirty) return;
    this.committing = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.root === root) { this.message = ""; this.commitInput.set_value(""); }
      } catch (e) { this.note = `提交失敗：${String(e?.message ?? e).slice(0, 300)}`; }
      finally { this.committing = false; if (this.root === root) this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    // A review was sent from the send dialog: its comments are spent, and this dialog has done its job.
    const sent = shared("review.sent");
    if (sent?.at && sent.at !== this.sentAt) {
      this.sentAt = sent.at;
      if (!sent.ask) { this.drafts = []; this.saveDrafts(); this.refreshMarks(); cx.timer.after(1, () => closeOverlay(this.overlay)); }
    }
    const t = theme(), files = this.files, cur = files[this.fileIdx], drafts = this.list();
    const c = diffColors(this.paletteId, t), colors = syntaxColors(t);
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const chip = (text, color, mono = false) => div().flex_none().max_w(220).truncate().h(20).px(6).flex().items_center().rounded(4).border_1()
      .border_color(`${color}66`).bg(`${color}18`).text_size(12).text_color(color).when(mono, (e) => e.font_family(MONO)).child(text);
    const button = (id, label, on_click, on = false) => div().id(id).h(26).px(8).flex().items_center().flex_none().rounded(6).border_1()
      .border_color(on ? t.accent : t.border).bg(on ? t.selected : "#00000000").text_size(12).text_color(on ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(on_click).child(label);

    const scopeInfo = SCOPES.find((s) => s[0] === this.scope);
    const header = v_flex().flex_none().gap(8).px(20).py(12).border_b(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(chip("Review", t.accent))
        .child(this.worktrees.length > 1
          ? button("rv-wt", `${nameOf(this.root ?? "")} ▾`, (_e, cx) => this.openWtMenu(cx))
          : chip(nameOf(this.root ?? ""), t.muted))
        .when(Boolean(this.info?.branch), (e) => e.child(chip(this.info.branch, t.ansi2)))
        .when(this.scope === "branch" && Boolean(this.info?.base), (e) => e.child(chip(`base ${this.info.base}`, t.ansi4)))
        .child(div().flex_1())
        .child(button("rv-submit", drafts.length ? `送出審查 · ${drafts.length}` : "送出審查", () => this.submit(), drafts.length > 0))
        .child(button("rv-refresh", "↻ r", (_e, cx) => this.refresh(cx)))
        .child(button("rv-close", "✕ Esc", () => closeOverlay(this.overlay))))
      .child(h_flex().gap(6).items_center()
        .children(SCOPES.map(([id, label], i) => button(`rv-scope-${id}`, `${i + 1} ${label}`, (_e, cx) => this.setScope(id, cx), this.scope === id)))
        .child(div().flex_1().min_w(0).truncate().pl(8).text_size(12).text_color(t.dim).child(scopeInfo?.[2] ?? "")));

    const tree = treeRows(files, this.collapsed, this.filter);
    const treeRow = (r) => {
      const pad = 10 + r.depth * 14;
      if (r.type === "dir") return h_flex().w_full().h(FILE_ROW_H).flex_none().pl(pad).pr(10).gap(6).items_center().cursor_pointer()
        .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(r.open ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_family(MONO).text_color(t.muted).child(r.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(String(r.count)));
      const f = r.f, on = this.fileIdx === r.idx;
      return h_flex().w_full().h(FILE_ROW_H).flex_none().pl(pad).pr(10).gap(6).items_center().cursor_pointer()
        .bg(on ? t.selected : "#00000000")
        .child(div().w(2).h(16).flex_none().rounded(1).bg(on ? t.accent : "#00000000"))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_family(MONO).text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold()).child(r.name))
        .when(f.untracked, (e) => e.child(div().flex_none().text_size(11).text_color(c.add).child("新")))
        .when(f.binary, (e) => e.child(div().text_size(11).text_color(t.dim).child("binary")))
        .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(c.add).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(c.del).child(`−${f.del}`)));
    };

    const filesPanel = v_flex().w(320).flex_none().h_full().border_r(1).border_color(t.border).bg(t.surface)
      .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(div().font_semibold().text_color(t.foreground).child(`異動檔案 (${files.length})`))
        .child(div().flex_1())
        .child(div().text_color(c.add).child(`+${add}`)).child(div().pl(4).text_color(c.del).child(`−${del}`)))
      .when(this.loading, (e) => e.child(div().px(12).py(10).text_size(12).text_color(t.muted).child("正在讀取…")))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(8).text_size(12).text_color(t.ansi3).child(this.note)))
      .when(Boolean(this.error), (e) => e.child(div().px(12).py(8).text_size(12).text_color(t.ansi1).child(this.error)))
      .when(!this.loading && !this.error && files.length === 0, (e) => e.child(div().px(12).py(10).text_size(12).text_color(t.dim).child("這個範圍沒有變更")))
      .child(h_flex().flex_none().mx(10).my(6).h(28).px(8).gap(6).items_center().rounded(6).bg(t.input ?? t.background).border_1().border_color(this.typing ? t.accent : t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.filterInput).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("rv-files", tree.length, FILE_ROW_H, (i) => tree[i].key,
          (range) => tree.slice(range.start, range.end).map((r) => treeRow(r)))
          .track_scroll(this.fileList)
          // A virtual list's rows may not carry handlers; one on the list names the row by its key.
          .on_item_click((key, cx) => {
            if (key.startsWith("d:")) { const p = key.slice(2); if (!this.collapsed.delete(p)) this.collapsed.add(p); }
            else this.pick(Number(key.slice(2)), cx);
            this.handle.focus(); cx.notify();
          })
          .size_full())
        .child(Scrollbar.vertical("rv-files").viewport_from_layout().absolute().inset_0()))
      .when(this.dirty > 0, (e) => e.child(v_flex().flex_none().gap(6).px(10).py(8).border_t(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(h_flex().flex_1().min_w(0).h(28).px(8).items_center().rounded(6).bg(t.input ?? t.background).border_1().border_color(this.typing ? t.accent : t.border)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.commitInput).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
          .child(button("rv-commit", this.committing ? "提交中…" : `提交 ${this.dirty}`, (_e, cx) => this.commit(cx), Boolean(this.message.trim()) && !this.committing)))
        .child(div().truncate().text_size(11).text_color(t.dim).child(`add -A 並 commit ${this.dirty} 個變更到 ${this.info?.branch ?? "HEAD"}（${nameOf(this.root ?? "")}）`))))
      .when(drafts.length > 0, (e) => e.child(v_flex().id("rv-drafts").flex_none().max_h(210).overflow_y_scrollbar().border_t(1).border_color(t.border)
        .child(div().px(12).py(6).text_size(11).font_semibold().text_color(t.muted).child(`待送出留言 (${drafts.length})`))
        .children(drafts.map((d) => h_flex().id(`rv-d-${d.id}`).flex_none().h(40).px(12).gap(8).items_center().cursor_pointer()
          .bg(this.editing === d.id ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.jumpTo(d, cx))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(11.5).font_family(MONO).text_color(t.muted).child(`${d.path}:${lineLabel(d)}${this.stale.has(d.id) ? "（過期）" : ""}`))
            .child(div().truncate().text_size(12.5).child(d.body.split("\n")[0])))
          .child(div().id(`rv-dd-${d.id}`).flex_none().px(6).py(2).rounded(4).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("刪除這則留言").on_click((_e, cx) => { cx.stop_propagation(); this.deleteDraft(d.id, cx); }).child("✕"))))))
      .child(div().flex_none().px(12).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child("j / k 切換檔案 · 點程式碼行留言 · 右鍵問 agent · Esc 關閉"));

    const editingDraft = this.editing ? drafts.find((d) => d.id === this.editing) : null;
    const canAdd = Boolean(this.composerText.trim());
    const composer = v_flex().flex_none().gap(6).px(14).py(10).border_t(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold()
          .child(`${editingDraft ? "編輯留言" : "留言"} · ${editingDraft ? `${editingDraft.path}:${lineLabel(editingDraft)}${this.stale.has(editingDraft.id) ? "（過期）" : ""}` : `${cur?.path ?? ""}:${this.selLabel()}`}`))
        .child(button("rv-c-cancel", "取消", (_e, cx) => { this.closeComposer(); cx.notify(); }))
        .child(button("rv-c-add", editingDraft ? "更新" : "加入留言", canAdd ? (_e, cx) => this.addComment(cx) : () => {}, canAdd)))
      .child(div().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).bg(t.input ?? t.background).px(10).py(6)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.composerInput).w_full().text_size(13).text_color(t.foreground)));
    const diffPane = v_flex().flex_1().min_w(0).h_full().bg(t.background)
      .child(h_flex().flex_none().h(36).px(14).gap(10).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(12)
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).font_semibold().text_color(t.foreground).child(cur?.path ?? ""))
        .when(Boolean(cur) && cur.add > 0, (e) => e.child(div().text_color(c.add).child(`+${cur.add}`)))
        .when(Boolean(cur) && cur.del > 0, (e) => e.child(div().text_color(c.del).child(`−${cur.del}`)))
        .child(button("rv-palette", `配色：${c.label}`, (_e, cx) => { this.cyclePalette(); cx.notify(); })))
      .child(div().flex_1().min_h(0).relative().font_family(MONO).text_size(12.5)
        .when(this.loadingFile, (e) => e.child(div().p(16).text_color(t.muted).child("正在讀取 diff…")))
        .when(!this.loadingFile && Boolean(cur?.binary) && this.rows.length === 0, (e) => e.child(div().p(16).text_color(t.dim).child("二進位檔案，沒有文字差異")))
        .child(div().id("rv-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(
            v_virtual_list("rv-rows", this.rows.length, DIFF_ROW_H, (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row, k) => {
                const i = range.start + k, inSel = this.sel && i >= this.sel.from && i <= this.sel.to;
                return diffRow(row, t, c, colors, DIFF_ROW_H).when(Boolean(inSel), (e) => e.bg(t.selected)).when(this.marks.has(i), (e) => e.border_r(3).border_color(t.accent));
              }))
            .track_scroll(this.rowList)
            // A virtual list's rows may not carry handlers: a click names its row by key.
            .on_item_click((key, cx) => this.clickRow(Number(key), cx))
            .on_item_secondary_click((key, _ev, _cx) => this.askAbout(Number(key)))
            .size_full())))
        .child(Scrollbar.vertical("rv-rows").viewport_from_layout().absolute().inset_0()))
      .when(Boolean(this.sel || this.editing) && Boolean(cur), (e) => e.child(composer));

    return v_flex().id("review").relative().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13.5)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(header)
      .child(h_flex().flex_1().min_h(0).child(filesPanel).child(diffPane))
      .when(Boolean(this.wtItems), (e) => e.child(this.renderWtMenu(t)));
  }
}
