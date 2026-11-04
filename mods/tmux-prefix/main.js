import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, focused, hc, keys, layout, nextCommand, openOverlay, panes, props, run, setShared, spaces, theme } from "herdr";

// Tmux-prefix engine: reads all bindings from keys.json under "mod:tmux-prefix".
const HINT_DELAY_MS = 200;

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function toggleSidePanel(child) {
  const root = layout();
  const panel = findNode(root, "panel");
  const body = findNode(root, "panel-body");
  const on = panel && !panel.hidden && body?.active === child;
  if (on) {
    run("layout.hide", { id: "panel" });
  } else {
    run("layout.select", { stack: "panel-body", child });
    run("layout.show", { id: "panel" });
  }
}

function formatLabel(action) {
  const custom = {
    "mod.open:picker-copy": "Goto picker",
    "mod.open:picker": "Goto picker",
    "mod.open:worktree": "New git worktree",
    "mod.open:worktree-plus": "New git worktree",
    "worktree-issue": "Bind / switch Issue",
    "mod.open:status-quota": "Quota details",
    "new-menu": "New agent / tab menu",
    "files": "Toggle Files panel",
    "changes": "Toggle Changes (diff)",
  };
  if (custom[action]) return custom[action];
  const [name, arg] = action.split(":");
  const words = name.replace(/[._]/g, " ");
  return arg ? `${words} ${arg}` : words;
}

function loadBindings() {
  return keys()
    .filter((b) => b.section === "mod:tmux-prefix" && b.action !== "tmux-prefix.send-prefix")
    .map((b) => {
      const rawKey = b.keys.trim();
      const m = /^shift-([a-z])$/i.exec(rawKey);
      const displayKey = m ? m[1].toUpperCase() : rawKey === "shift-\\" ? "|" : rawKey;
      const action = b.action.replace(/^tmux-prefix\./, "");
      return { rawKey, displayKey, action, label: formatLabel(action) };
    });
}

function runAction(action, targetPane, targetCwd) {
  if (action === "files" || action === "changes") {
    toggleSidePanel(action);
    return;
  }
  if (action === "new-menu") {
    openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
    return;
  }
  if (action === "mod.open:worktree" || action === "mod.open:worktree-plus" || action === "worktree") {
    const sp = spaces().find((s) => s.active);
    setShared("worktree-plus.request", { action: "new", space: sp?.id ?? null, folder: targetCwd });
    run("mod.open", { name: "worktree-plus" });
    return;
  }
  if (action === "worktree-issue") {
    const sp = spaces().find((s) => s.active);
    setShared("worktree-plus.request", { action: "issue", space: sp?.id ?? null, folder: targetCwd });
    run("mod.open", { name: "worktree-plus" });
    return;
  }
  if (action === "space.close") {
    const sp = spaces().find((s) => s.active);
    const wtFolder = sp?.folder || targetCwd;
    if (wtFolder && wtFolder.includes("/.herdr/worktrees/")) {
      run("space.close", { id: sp.id, confirmed: true });
      return;
    }
  }
  const idx = action.indexOf(":");
  const name = idx === -1 ? action : action.slice(0, idx);
  const val = idx === -1 ? undefined : action.slice(idx + 1);
  const pane = focused()?.pane ?? targetPane;
  const args = {};
  if (val !== undefined) {
    if (name === "pane.split" || name === "pane.go" || name === "pane.swap") args.direction = val;
    else if (name === "tab.select" || name === "space.select") args.index = /^\d+$/.test(val) ? Number(val) : val;
    else if (name === "mod.open" || name === "app.theme" || name === "layout.switch") args.name = val;
    else if (name.startsWith("layout.")) args.id = val;
    else if (name === "app.settings") args.section = val;
    else args.id = val;
  }
  if (["pane.split", "pane.close", "pane.zoom", "pane.swap"].includes(name) && pane) {
    args.pane = pane;
  }
  run(name, args);
}

export default class TmuxPrefix extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(20, () => {
      if (!this.closed) this.handle.focus();
    });
    const f = focused();
    this.targetPane = f?.pane ?? null;
    this.targetCwd = f?.cwd ?? null;
    this.all = false;
    this.closed = false;
    this.showHint = false;
    cx.timer.after(HINT_DELAY_MS, () => {
      if (!this.closed) {
        this.showHint = true;
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "send-prefix") {
          this.sendPrefix(cx);
        } else if (cmd) {
          this.dismiss();
          runAction(cmd, this.targetPane, this.targetCwd);
        }
      }
    });
  }

  dismiss() {
    if (this.closed) return;
    this.closed = true;
    closeOverlay(props().overlay);
  }

  send(key, cx) {
    const terminal = focused()?.terminal;
    if (!terminal) return this.dismiss();
    const pending = hc(["keys", terminal, key]);
    cx.spawn(async () => {
      const result = await pending;
      if (result.code !== 0) console.log(`tmux-prefix: ${result.stderr}`);
    });
    this.dismiss();
  }

  sendPrefix(cx) {
    this.send("ctrl+a", cx);
  }

  key(e, cx) {
    cx.stop_propagation();
    const m = e.modifiers;
    if (e.key === "escape") return this.dismiss();
    if (m.control && e.key === "a") return this.sendPrefix(cx);
    const allow = !m.alt && !m.platform;
    const raw = (!m.control && e.key_char) || (m.shift && e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const key = allow ? raw : e.key;
    if (allow && key === "?") {
      this.all = !this.all;
      this.showHint = true;
      cx.notify();
      return;
    }
    const bindings = loadBindings();
    const binding = allow && bindings.find((b) => b.displayKey === key || b.rawKey === key);
    this.dismiss();
    if (!binding) return;
    runAction(binding.action, this.targetPane, this.targetCwd);
  }

  render() {
    const t = theme();
    const root = v_flex().id("tmux-prefix").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx));
    if (!this.showHint) return root.size_0();
    const bindings = loadBindings();
    const rows = this.all
      ? bindings
      : bindings.filter((b) => !["left", "right", "up", "down", "\\", "|", "w"].includes(b.displayKey) && !/^\d$/.test(b.displayKey));
    return root
      .p(14).gap(8).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().justify_between().child(div().font_semibold().child("Ctrl+A · waiting for a key"))
        .child(div().text_color(t.muted).child("Esc cancel · ^A send prefix")))
      .child(v_flex().h(320).min_h(0).overflow_y_scrollbar().children(rows.map((b) =>
        h_flex().h(20).flex_none().items_center().gap(12).child(div().w(40).text_color(t.accent).child(b.displayKey))
          .child(div().flex_1().child(b.label)))))
      .child(div().text_color(t.muted).child("Edit keys.json -> mod:tmux-prefix · ? all bindings"));
  }
}
