import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { exec, theme, closeOverlay, props } from "herdr";
import { treeRows } from "./filetree.js";
import { parseDiff } from "./diff.js";
import { diffColors, diffRow, loadPaletteId, nextPaletteId, savePaletteId, syntaxColors, tokenizeRows } from "./diffview.js";

// Read-only review of a working tree, opened as a dialog from the Git panel's 審查 button with { root, on }.
// Same safe flags as the Changes panel: never take index.lock (an agent's commit may need it), never start
// fsmonitor, never rewrite the index.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MONO = "JetBrains Mono";
const FILE_ROW_H = 28, DIFF_ROW_H = 22, MAX_DIFF_ROWS = 5000;
const PALETTE_KEY = "review.diffPalette", SCOPE_KEY = "review.scopes";
// [id, label, what it compares]
const SCOPES = [
  ["work", "未提交", "工作目錄 vs HEAD"],
  ["last", "最後一個 commit", "HEAD 的上一個 commit → 工作目錄（含未提交）"],
  ["branch", "對 base", "與 base 分支分岔後的全部變更（含未提交）"],
];

const remembered = () => { try { return JSON.parse(localStorage.getItem(SCOPE_KEY) ?? "{}"); } catch { return {}; } };

export default class Review extends View {
  init(_props, cx) {
    const pr = props() ?? {};
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
    this.fileIdx = idx; this.rows = []; this.diffWidth = 0;
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
  }

  // Next / previous file among the rows the tree shows (folders collapsed or filtered away are skipped).
  step(delta, cx) {
    const rows = treeRows(this.files, this.collapsed, this.filter), shown = rows.filter((r) => r.type === "file");
    if (!shown.length) return;
    const next = shown[(shown.findIndex((r) => r.idx === this.fileIdx) + delta + shown.length) % shown.length];
    this.pick(next.idx, cx);
    this.fileList.scroll_to_item(rows.indexOf(next), "center");
  }

  cyclePalette() {
    this.paletteId = nextPaletteId(this.paletteId);
    savePaletteId(PALETTE_KEY, this.paletteId);
  }

  onKey(e, cx) {
    const k = e.key, ctrl = e.modifiers?.control;
    if (this.typing) {
      // Keys belong to the filter box; Escape hands the keyboard back to the dialog.
      if (k === "escape") { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
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

  render(cx) {
    const t = theme(), files = this.files, cur = files[this.fileIdx];
    const c = diffColors(this.paletteId, t), colors = syntaxColors(t);
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const name = (this.root ?? "").split("/").filter(Boolean).pop() ?? "";
    const chip = (text, color, mono = false) => div().flex_none().max_w(220).truncate().h(20).px(6).flex().items_center().rounded(4).border_1()
      .border_color(`${color}66`).bg(`${color}18`).text_size(12).text_color(color).when(mono, (e) => e.font_family(MONO)).child(text);
    const button = (id, label, on_click, on = false) => div().id(id).h(26).px(8).flex().items_center().flex_none().rounded(6).border_1()
      .border_color(on ? t.accent : t.border).bg(on ? t.selected : "#00000000").text_size(12).text_color(on ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(on_click).child(label);

    const scopeInfo = SCOPES.find((s) => s[0] === this.scope);
    const header = v_flex().flex_none().gap(8).px(20).py(12).border_b(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(chip("Review", t.accent))
        .child(chip(name, t.muted))
        .when(Boolean(this.info?.branch), (e) => e.child(chip(this.info.branch, t.ansi2)))
        .when(this.scope === "branch" && Boolean(this.info?.base), (e) => e.child(chip(`base ${this.info.base}`, t.ansi4)))
        .child(div().flex_1())
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
      .child(div().flex_none().px(12).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child("j / k 切換檔案 · 1 2 3 切換範圍 · r 重新讀取 · Esc 關閉"));

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
              (range) => this.rows.slice(range.start, range.end).map((row) => diffRow(row, t, c, colors, DIFF_ROW_H))).size_full())))
        .child(Scrollbar.vertical("rv-rows").viewport_from_layout().absolute().inset_0()));

    return v_flex().id("review").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13.5)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(header)
      .child(h_flex().flex_1().min_h(0).child(filesPanel).child(diffPane));
  }
}
