import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { exec, theme, closeOverlay } from "herdr";
import { treeRows } from "./filetree.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const MONO = "JetBrains Mono";
const FILE_ROW_H = 28, DIFF_ROW_H = 22, MAX_DIFF_ROWS = 5000;

// Diff colors, cycled from the diff header and remembered. null add/del = the theme's green/red; `a` is the tint's alpha (hex).
const PALETTES = [
  { id: "theme", label: "主題", add: null, del: null, a: "18" },
  { id: "vivid", label: "鮮明", add: null, del: null, a: "33" },
  { id: "github", label: "GitHub", add: "#2ea043", del: "#f85149", a: "26" },
  { id: "cb", label: "藍橘（色盲友善）", add: "#388bfd", del: "#f0883e", a: "2e" },
];
const PALETTE_KEY = "commit.diffPalette";

const pad = (n) => String(n).padStart(2, "0");
const fullDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Unified `diff --git` text → [{ path, add, del, binary, rows: [{ kind: "@"|"+"|"-"|" ", number?, text }] }].
export function parseDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
    const file = { path: m ? m[2] : (lines[0] ?? "").trim(), add: 0, del: 0, binary: false, rows: [] };
    let oldLine = 0, newLine = 0, inHunk = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { file.binary = true; continue; }
      if (line.startsWith("@@")) {
        const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hm) { oldLine = Number(hm[1]); newLine = Number(hm[2]); }
        inHunk = true;
        file.rows.push({ kind: "@", text: line });
      } else if (!inHunk) continue;
      else if (line.startsWith("+")) { file.add++; file.rows.push({ kind: "+", number: newLine++, text: line.slice(1) }); }
      else if (line.startsWith("-")) { file.del++; file.rows.push({ kind: "-", number: oldLine++, text: line.slice(1) }); }
      else if (line.startsWith(" ")) { oldLine++; file.rows.push({ kind: " ", number: newLine++, text: line.slice(1) }); }
    }
    files.push(file);
  }
  return files;
}

// One commit in a dialog: { commit: { hash, parents, author, time, subject, refs }, root, on } from the graph.
export class CommitDialog {
  constructor({ commit, root, on }, overlay, cx) {
    Object.assign(this, { commit, root, on, overlay });
    this.body = null; this.files = []; this.fileIdx = 0; this.rows = []; this.diffWidth = 0;
    this.loading = true; this.error = null;
    // The files column is a folder tree: folders the user collapsed, and the filter box above it.
    this.collapsed = new Set(); this.filter = ""; this.typing = false;
    this.filterInput = InputState.new({ placeholder: "篩選檔案…" });
    this.filterInput.on("change", (_e, cx) => { this.filter = this.filterInput.value(); cx.notify(); });
    this.filterInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.fileList = VirtualListScrollHandle.new();
    try { this.paletteId = localStorage.getItem(PALETTE_KEY) ?? "theme"; } catch { this.paletteId = "theme"; }
    cx.timer.after(40, () => this.handle.focus());
    this.load(cx);
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }

  load(cx) {
    const { hash } = this.commit;
    cx.spawn(async (cx) => {
      try {
        // First-parent diff for merges, root diff for the first commit: the same rule as the graph's inline detail.
        const [msg, diff] = await Promise.all([
          this.git(["show", "-s", "--format=%B", hash]),
          this.git(["diff-tree", "-p", "--no-commit-id", "-r", "-M", "--root", "-m", "--first-parent", hash]),
        ]);
        if (diff.code !== 0) throw new Error(diff.stderr.trim() || "git diff-tree failed");
        this.body = msg.stdout.trim().split("\n").slice(1).join("\n").trim();
        this.files = parseDiff(diff.stdout);
        this.pick(0);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  pick(idx) {
    this.fileIdx = this.files.length ? Math.max(0, Math.min(idx, this.files.length - 1)) : 0;
    const rows = this.files[this.fileIdx]?.rows ?? [];
    this.rows = rows.length > MAX_DIFF_ROWS ? [...rows.slice(0, MAX_DIFF_ROWS), { kind: "@", text: `Diff truncated at ${MAX_DIFF_ROWS} lines` }] : rows;
    let longest = 0;
    for (const r of this.rows) if (r.text.length > longest) longest = r.text.length;
    this.diffWidth = Math.min(longest, 400) * 8 + 100;
  }

  // Next / previous file among the rows the tree shows (folders collapsed or filtered away are skipped).
  step(delta) {
    const rows = treeRows(this.files, this.collapsed, this.filter), shown = rows.filter((r) => r.type === "file");
    if (!shown.length) return;
    const next = shown[(shown.findIndex((r) => r.idx === this.fileIdx) + delta + shown.length) % shown.length];
    this.pick(next.idx);
    this.fileList.scroll_to_item(rows.indexOf(next), "center");
  }

  cyclePalette() {
    const at = PALETTES.findIndex((x) => x.id === this.paletteId);
    this.paletteId = PALETTES[(at + 1) % PALETTES.length].id;
    try { localStorage.setItem(PALETTE_KEY, this.paletteId); } catch { /* memory only */ }
  }

  onKey(e, cx) {
    const k = e.key, ctrl = e.modifiers?.control;
    if (this.typing) {
      // Keys belong to the filter box; Escape hands the keyboard back to the dialog.
      if (k === "escape") { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (k === "escape" || k === "q") closeOverlay(this.overlay);
    else if (k === "j" || k === "down" || (ctrl && (k === "n"))) this.step(1);
    else if (k === "k" || k === "up" || (ctrl && (k === "p"))) this.step(-1);
    else return;
    cx.stop_propagation(); cx.notify();
  }

  chip(text, color, t, mono = false) {
    return div().flex_none().max_w(160).truncate().h(20).px(6).flex().items_center().rounded(4).border_1().border_color(`${color}66`).bg(`${color}18`)
      .text_size(12).text_color(color).when(mono, (e) => e.font_family(MONO)).child(text);
  }

  diffRow({ kind, number, text }, t, c) {
    if (kind === "@") return div().w_full().px(12).h(DIFF_ROW_H).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const tone = kind === "+" ? c.add : kind === "-" ? c.del : null;
    return h_flex().w_full().h(DIFF_ROW_H).flex_none()
      .when(Boolean(tone), (e) => e.bg(tone + c.a))
      .child(div().w(3).h_full().flex_none().when(Boolean(tone), (e) => e.bg(tone)))
      .child(div().w(40).flex_none().text_right().text_color(tone ?? t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).pl(10).truncate().child(text));
  }

  render(cx) {
    const t = theme(), commit = this.commit, files = this.files, cur = files[this.fileIdx];
    const pal = PALETTES.find((x) => x.id === this.paletteId) ?? PALETTES[0];
    const c = { ...pal, add: pal.add ?? t.ansi2, del: pal.del ?? t.ansi1 };
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const refColor = { head: t.accent, branch: t.ansi2, remote: t.ansi4, tag: t.ansi3 };
    const button = (id, label, on_click) => div().id(id).h(26).px(8).flex().items_center().flex_none().rounded(6).border_1().border_color(t.border).text_size(12)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(on_click).child(label);

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
        .when(f.binary, (e) => e.child(div().text_size(11).text_color(t.dim).child("binary")))
        .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(c.add).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(c.del).child(`−${f.del}`)));
    };

    const header = v_flex().flex_none().gap(8).px(20).py(12).border_b(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(this.chip("Commit", t.accent, t))
        .child(this.chip(commit.hash.slice(0, 10), t.muted, t, true))
        .children((commit.refs ?? []).slice(0, 6).map((r) => this.chip(r.name, refColor[r.kind] ?? t.muted, t)))
        .child(div().flex_1())
        .child(button("cd-close", "✕ Esc", () => closeOverlay(this.overlay))))
      .child(div().text_size(18).font_semibold().child(commit.subject))
      .child(div().text_size(12.5).text_color(t.dim)
        .child(`${commit.author} · ${fullDate(commit.time)}${commit.parents.length > 1 ? ` · merge of ${commit.parents.map((p) => p.slice(0, 7)).join(" + ")}` : commit.parents.length === 0 ? " · root commit" : ` · parent ${commit.parents[0].slice(0, 7)}`}`));

    // Left to right: the commit's message (its own full-height column, scrolls), the changed files as a tree, the file's diff.
    const info = v_flex().id("cd-info").w(340).flex_none().h_full().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(8).border_r(1).border_color(t.border)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child("說明"))
      .child(div().text_size(13.5).text_color(this.body ? t.foreground : t.dim).child(this.body || (this.loading ? "載入中…" : "（沒有內文）")))
      .child(div().text_size(11).text_color(t.dim).font_family(MONO).child(commit.hash));

    const filesPanel = v_flex().w(290).flex_none().h_full().border_r(1).border_color(t.border).bg(t.surface)
      .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(div().font_semibold().text_color(t.foreground).child(`異動檔案 (${files.length})`))
        .child(div().flex_1())
        .child(div().text_color(c.add).child(`+${add}`)).child(div().pl(4).text_color(c.del).child(`−${del}`)))
      .when(this.loading, (e) => e.child(div().px(12).py(10).text_size(12).text_color(t.muted).child("正在載入 Diff…")))
      .when(Boolean(this.error), (e) => e.child(div().px(12).py(8).text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_none().mx(10).my(6).h(28).px(8).gap(6).items_center().rounded(6).bg(t.input ?? t.background).border_1().border_color(this.typing ? t.accent : t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.filterInput).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("cd-files", tree.length, FILE_ROW_H, (i) => tree[i].key,
          (range) => tree.slice(range.start, range.end).map((r) => treeRow(r)))
          .track_scroll(this.fileList)
          // A virtual list's rows may not carry handlers; one on the list names the row by its key.
          .on_item_click((key, cx) => {
            if (key.startsWith("d:")) { const p = key.slice(2); if (!this.collapsed.delete(p)) this.collapsed.add(p); }
            else this.pick(Number(key.slice(2)));
            this.handle.focus(); cx.notify();
          })
          .size_full())
        .child(Scrollbar.vertical("cd-files").viewport_from_layout().absolute().inset_0()))
      .child(div().flex_none().px(12).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child("j / k 或 ↑ / ↓ 切換檔案 · Esc 關閉"));

    const diffPane = v_flex().flex_1().min_w(0).h_full().bg(t.background)
      .child(h_flex().flex_none().h(36).px(14).gap(10).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(12)
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).font_semibold().text_color(t.foreground).child(cur?.path ?? ""))
        .when(Boolean(cur) && cur.add > 0, (e) => e.child(div().text_color(c.add).child(`+${cur.add}`)))
        .when(Boolean(cur) && cur.del > 0, (e) => e.child(div().text_color(c.del).child(`−${cur.del}`)))
        .child(button("cd-palette", `配色：${c.label}`, (_e, cx) => { this.cyclePalette(); cx.notify(); })))
      .child(div().flex_1().min_h(0).relative().font_family(MONO).text_size(12.5)
        .when(Boolean(cur?.binary) && this.rows.length === 0, (e) => e.child(div().p(16).text_color(t.dim).child("二進位檔案，沒有文字差異")))
        .child(div().id("cd-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(
            v_virtual_list("cd-rows", this.rows.length, DIFF_ROW_H, (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, c))).size_full())))
        .child(Scrollbar.vertical("cd-rows").viewport_from_layout().absolute().inset_0()));

    return v_flex().id("commit-dialog").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13.5)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(header)
      .child(h_flex().flex_1().min_h(0).child(info).child(filesPanel).child(diffPane));
  }
}
