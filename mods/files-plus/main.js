// A lazy file browser for the focused pane's folder, with bounded read-only previews. Fork of Herdr's `files`, plus
// buttons that open the file (or folder) in Finder, Zed or Chrome.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, home, readTextFile, watchFolder, theme, settings, window, notify, props, openOverlay, closeOverlay } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

const ico = (name, size, color) => svg(`mods/files-plus/icons/${name}.svg`).size(size).flex_none().when(Boolean(color), el => el.text_color(color));
// `open` is on every Mac and finds the apps by name; a file is revealed (selected) in Finder, a folder is opened.
// A plain promise, not cx.spawn: the right-click menu closes its own view right after the click.
function openPath(app, abs, isFile) {
  const args = app === "finder" ? (isFile ? ["-R", abs] : [abs]) : ["-a", app === "zed" ? "Zed" : "Google Chrome", abs];
  exec("open", args).catch(e => ({ code: 1, stderr: String(e) })).then(r => {
    if (r.code !== 0) notify({ title: "開啟失敗", body: (r.stderr || r.stdout || "").trim().slice(0, 200) || args.join(" "), level: "error" });
  });
}

export default class Files extends View {
  init(_props, cx) {
    // The right-click menu is this mod opened as a popup, told so by props.
    const pr = props() ?? {};
    if (pr.menu) { this.menu = { ...pr.menu, overlay: pr.overlay }; return; }
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.sel = null; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // An image can only be drawn from the app's own folder, so it is copied there (one preview at a time, 20 MB at most).
  showImage(path, cx) {
    const ext = path.split(".").pop().toLowerCase(), n = (this.imageN = (this.imageN ?? 0) + 1);
    const rel = `data/files-plus/preview-${n}.${ext}`, context = this.context, src = `${this.root}/${path}`;
    cx.spawn(async cx => {
      try {
        const script = 'dir=$(dirname "$2"); mkdir -p "$dir" && [ "$(wc -c < "$1")" -le 20971520 ] && rm -f "$dir"/preview-* && cp "$1" "$2"';
        const r = await exec("sh", ["-c", script, "files", src, `${home()}/.config/herdr-app/${rel}`]);
        if (this.file !== path || !this.current(context)) return;
        if (r.code === 0) this.image = rel; else this.fileError = "Cannot preview this image (too large or unreadable)";
      } catch { if (this.file === path) this.fileError = "Cannot preview this image"; }
      finally { cx.notify(); }
    });
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.image = null;
    if (!path || !cx) return;
    if (!this.on && IMAGES.has(path.split(".").pop().toLowerCase())) { this.showImage(path, cx); return; }
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // What the open buttons act on: the file being viewed, else the folder last clicked, else the root.
  target() {
    const rel = this.file ?? this.sel ?? "";
    return { rel, abs: rel ? `${this.root}/${rel}` : this.root, isFile: Boolean(this.file) };
  }

  openWith(app) {
    const { abs, isFile } = this.target();
    if (abs && !this.on) openPath(app, abs, isFile);
  }

  // Right-click on a row: a small menu at the pointer to open that entry (not just the selected one).
  openMenu(abs, isFile) {
    if (!this.root || this.on) return;
    openOverlay({ mod: "files-plus", kind: "popup", width: 200, height: 4 * 34 + 8, at: "pointer", props: { menu: { abs, isFile } } });
  }

  renderMenu(t) {
    const m = this.menu;
    const item = (id, icon, color, label, on_click) => h_flex().id(id).h(34).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => { on_click(cx); closeOverlay(m.overlay); })
      .child(ico(icon, 14, color)).child(div().text_size(13).child(label));
    return v_flex().id("files-menu").size_full().p(4).bg(t.popover).text_color(t.foreground)
      .child(item("fm-finder", "folder", t.ansi3, m.isFile ? "Reveal in Finder" : "Open in Finder", () => openPath("finder", m.abs, m.isFile)))
      .child(item("fm-zed", "code", t.ansi4, "Open in Zed", () => openPath("zed", m.abs, m.isFile)))
      .child(item("fm-chrome", "globe", t.ansi6, "Open in Chrome", () => openPath("chrome", m.abs, m.isFile)))
      .child(item("fm-copy", "copy", t.muted, "Copy path", cx => cx.write_to_clipboard(m.abs)));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.sel = entry.dir ? path : prefix; entry.dir ? this.toggle(path, cx) : this.show(path, cx); })
        .on_mouse_down("right", () => this.openMenu(`${this.root}/${path}`, !entry.dir))
        .child(entry.dir ? svg(`mods/files-plus/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-plus/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (this.menu) return this.renderMenu(theme());
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const target = this.target(), local = Boolean(this.root) && !this.on;
    // An icon in the app's color and its name (apps are named the same in every language); the tooltip has the rest.
    const open = (id, label, app, icon, color) => div().id(id).h(24).px(8).gap(5).flex().items_center().flex_none().rounded(6).border_1().border_color(t.border)
      .text_size(12).text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`用 ${label} 開啟 ${target.rel || "這個資料夾"}`).on_click((_e, cx) => this.openWith(app, cx)).child(ico(icon, 14, color)).child(label);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      // Open the file being viewed, else the folder last clicked, else the root: in Finder, Zed or Chrome (this computer only).
      .when(local, el => el.child(h_flex().flex_none().h(36).px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(target.rel || ico("folder", 14, t.ansi3)))
        .child(open("files-open-finder", "Finder", "finder", "folder", t.ansi3))
        .child(open("files-open-zed", "Zed", "zed", "code", t.ansi4))
        .child(open("files-open-chrome", "Chrome", "chrome", "globe", t.ansi6))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file) && Boolean(this.image), el => el.child(div().id("files-image").flex_1().min_h(0).p(12).flex().items_center().justify_center().overflow_hidden()
        .child(image(this.image).max_w_full().max_h_full())))
      .when(Boolean(this.file) && !this.image, el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
