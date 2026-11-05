import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, focused, hc, nextCommand, notify, panes, props, shared, setShared, spaces, theme } from "herdr";

const ROW_H = 21;
const MAX_LINES = 2500;
const MONO = "JetBrains Mono";

// Nerd-font / powerline icon glyphs live in the Unicode Private Use Areas.
// Our mod's font has no matching glyph for them, so they render as garbled
// boxes. They're decorative chrome (status-bar icons, prompt separators),
// not real content, so drop them instead of showing tofu.
const PUA_RE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
function stripIconGlyphs(text) {
  return text.replace(PUA_RE, "");
}

function activeTarget() {
  const req = shared("scrollback.request");
  if (req) setShared("scrollback.request", null);
  const pr = props() ?? {};
  const f = focused();
  const term = req?.terminal ?? pr.terminal ?? f?.terminal ?? panes().find((p) => p.focused)?.terminal ?? panes()[0]?.terminal ?? null;
  const pane = panes().find((p) => p.terminal === term) ?? null;
  const sp = spaces().find((s) => s.active) ?? null;
  return {
    terminal: term,
    title: pane?.title || pane?.app || term || "Terminal",
    cwd: req?.cwd ?? pr.cwd ?? pane?.cwd ?? f?.cwd ?? sp?.folder ?? "",
  };
}

export default class Scrollback extends View {
  init(_props, cx) {
    const target = activeTarget();
    this.terminal = target.terminal;
    this.title = target.title;
    this.cwd = target.cwd;
    this.overlay = props()?.overlay;
    this.lines = [];
    this.loading = true;
    this.error = null;
    this.cursor = 0;
    this.scroll = 0;
    this.viewH = 620;
    this.markLine = null;
    this.searching = false;
    this.query = "";
    this.matches = [];
    this.matchIdx = -1;
    this.pendingG = false;

    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "輸入關鍵字搜尋歷史輸出（Enter 跳至命中行 · Esc 返回捲動）…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.recomputeMatches(true);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => {
      this.searching = false;
      this.handle.focus();
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.searching = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.searching = false; cx.notify(); });

    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
    cx.timer.after(150, () => this.handle.focus());

    this.load(cx);

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") this.handle.focus();
        else if (cmd === "down") this.move(1);
        else if (cmd === "up") this.move(-1);
        else if (cmd === "half-down") this.move(Math.max(5, Math.floor(this.visibleRows() / 2)));
        else if (cmd === "half-up") this.move(-Math.max(5, Math.floor(this.visibleRows() / 2)));
        cx.notify();
      }
    });
  }

  visibleRows() {
    return Math.max(8, Math.floor(this.viewH / ROW_H));
  }

  load(cx) {
    if (!this.terminal) {
      this.loading = false;
      this.error = "找不到目前聚焦的終端機";
      return;
    }
    this.loading = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const res = await hc(["read", this.terminal, "--lines", String(MAX_LINES)]);
        if (res.code !== 0) throw new Error((res.stderr || res.stdout || "hc read failed").trim());
        const raw = (res.stdout ?? "").replace(/\r\n/g, "\n").split("\n").map(stripIconGlyphs);
        while (raw.length > 1 && raw[raw.length - 1].trim() === "") raw.pop();
        this.lines = raw.length ? raw : ["（目前終端機沒有輸出內容）"];
        this.cursor = Math.max(0, this.lines.length - 1);
        this.ensureVisible(true);
        if (this.query.trim()) this.recomputeMatches(false);
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        this.handle.focus();
        cx.notify();
      }
    });
  }

  recomputeMatches(jumpToNearest) {
    const q = this.query.trim().toLowerCase();
    if (!q) {
      this.matches = [];
      this.matchIdx = -1;
      return;
    }
    const found = [];
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].toLowerCase().includes(q)) found.push(i);
    }
    this.matches = found;
    if (!found.length) {
      this.matchIdx = -1;
      return;
    }
    if (jumpToNearest) {
      let idx = found.length - 1;
      for (let i = found.length - 1; i >= 0; i--) {
        if (found[i] <= this.cursor) { idx = i; break; }
      }
      this.matchIdx = idx;
      this.cursor = found[idx];
      this.ensureVisible(true);
    }
  }

  stepMatch(delta) {
    if (!this.matches.length) return;
    this.matchIdx = ((this.matchIdx < 0 ? 0 : this.matchIdx) + delta + this.matches.length) % this.matches.length;
    this.cursor = this.matches[this.matchIdx];
    this.ensureVisible(true);
  }

  ensureVisible(center = false) {
    const total = this.lines.length * ROW_H;
    const height = Math.min(this.viewH, Math.max(ROW_H, total));
    const maxScroll = Math.max(0, total - height);
    if (center) {
      this.scroll = Math.max(0, Math.min(this.cursor * ROW_H - Math.floor(height / 2), maxScroll));
      return;
    }
    if (this.cursor * ROW_H < this.scroll) this.scroll = this.cursor * ROW_H;
    if ((this.cursor + 1) * ROW_H > this.scroll + height) this.scroll = (this.cursor + 1) * ROW_H - height;
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
  }

  move(delta) {
    if (!this.lines.length) return;
    this.cursor = Math.max(0, Math.min(this.lines.length - 1, this.cursor + delta));
    this.ensureVisible(false);
  }

  copySelection(cx, all = false) {
    if (!this.lines.length) return;
    if (all) {
      cx.write_to_clipboard(this.lines.join("\n"));
      notify({ title: "已複製全部終端機輸出", body: `共 ${this.lines.length} 行`, level: "success", timeout: 2200 });
      return;
    }
    if (this.markLine !== null) {
      const a = Math.min(this.markLine, this.cursor);
      const b = Math.max(this.markLine, this.cursor);
      const text = this.lines.slice(a, b + 1).join("\n");
      cx.write_to_clipboard(text);
      this.markLine = null;
      notify({ title: `已複製第 ${a + 1}～${b + 1} 行`, body: `共 ${b - a + 1} 行`, level: "success", timeout: 2200 });
      return;
    }
    const text = this.lines[this.cursor] ?? "";
    cx.write_to_clipboard(text);
    notify({ title: `已複製第 ${this.cursor + 1} 行`, body: text.trim().slice(0, 72) || "（空白行）", level: "success", timeout: 2000 });
  }

  close() {
    closeOverlay(this.overlay);
  }

  onKey(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (this.searching) {
      if (k === "escape") {
        this.searching = false;
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
      } else if (m.control && (k === "j" || k === "n")) {
        this.stepMatch(1);
        cx.stop_propagation();
        cx.notify();
      } else if (m.control && (k === "k" || k === "p")) {
        this.stepMatch(-1);
        cx.stop_propagation();
        cx.notify();
      }
      return;
    }

    if (k === "g" && !m.shift && !m.control) {
      if (this.pendingG) {
        this.pendingG = false;
        this.cursor = 0;
        this.ensureVisible(false);
      } else {
        this.pendingG = true;
        this.cursor = 0;
        this.ensureVisible(false);
        cx.timer.after(350, () => { this.pendingG = false; });
      }
      cx.stop_propagation();
      cx.notify();
      return;
    }
    this.pendingG = false;

    const half = Math.max(6, Math.floor(this.visibleRows() / 2));
    const full = Math.max(12, this.visibleRows() - 2);

    if (k === "escape" || k === "q") {
      if (this.markLine !== null && k === "escape") {
        this.markLine = null;
        cx.stop_propagation();
        cx.notify();
        return;
      }
      cx.stop_propagation();
      this.close();
    } else if (k === "j" || k === "down" || (m.control && (k === "n" || k === "j"))) {
      this.move(1);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "k" || k === "up" || (m.control && (k === "p" || k === "k"))) {
      this.move(-1);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "d" || (m.control && k === "d")) {
      this.move(half);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "u" || (m.control && k === "u")) {
      this.move(-half);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "f" || k === " " || k === "pagedown" || (m.control && k === "f")) {
      this.move(full);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "b" || k === "pageup" || (m.control && k === "b")) {
      this.move(-full);
      cx.stop_propagation();
      cx.notify();
    } else if ((k === "g" && m.shift) || k === "G" || k === "end") {
      this.cursor = Math.max(0, this.lines.length - 1);
      this.ensureVisible(false);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "home") {
      this.cursor = 0;
      this.ensureVisible(false);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "/") {
      this.searching = true;
      this.input.focus();
      cx.stop_propagation();
      cx.notify();
    } else if (k === "n" && !m.shift) {
      this.stepMatch(1);
      cx.stop_propagation();
      cx.notify();
    } else if ((k === "n" && m.shift) || k === "N") {
      this.stepMatch(-1);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "v" || (k === "V" && m.shift)) {
      this.markLine = this.markLine === null ? this.cursor : null;
      cx.stop_propagation();
      cx.notify();
    } else if (k === "y" && !m.shift) {
      this.copySelection(cx, false);
      cx.stop_propagation();
      cx.notify();
    } else if ((k === "y" && m.shift) || k === "Y") {
      this.copySelection(cx, true);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "r") {
      this.load(cx);
      cx.stop_propagation();
      cx.notify();
    }
  }

  render() {
    const t = theme();
    const total = this.lines.length * ROW_H;
    const height = Math.min(this.viewH, Math.max(ROW_H, total));
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));

    const matchSet = new Set(this.matches);
    const selStart = this.markLine !== null ? Math.min(this.markLine, this.cursor) : this.cursor;
    const selEnd = this.markLine !== null ? Math.max(this.markLine, this.cursor) : this.cursor;

    const placeRow = (el, idx) => fixed
      ? el.absolute().left(0).right(12).top(idx * ROW_H - this.scroll).h(ROW_H)
      : el;
    const visible = (idx) => !fixed || ((idx + 1) * ROW_H > this.scroll && idx * ROW_H < this.scroll + height);

    const renderRow = (line, idx) => {
      const isCursor = idx === this.cursor;
      const inRange = idx >= selStart && idx <= selEnd;
      const isMatch = matchSet.has(idx);
      const bg = isCursor
        ? t.selected
        : this.markLine !== null && inRange
        ? `${t.accent}24`
        : isMatch
        ? `${t.ansi3}22`
        : "#00000000";
      return h_flex()
        .id(`sb-row-${idx}`)
        .h(ROW_H)
        .flex_none()
        .px(12)
        .gap(12)
        .items_center()
        .cursor_pointer()
        .bg(bg)
        .when(isCursor, (el) => el.border_l(2).border_color(t.accent))
        .hover((s) => s.bg(isCursor ? t.selected : t.hover))
        .on_click((_e, cx) => {
          this.cursor = idx;
          cx.notify();
        })
        .child(div().w(44).flex_none().text_right().font_family(MONO).text_size(11.5).text_color(isCursor ? t.accent : isMatch ? t.ansi3 : t.dim).child(String(idx + 1)))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(12.8).text_color(isCursor ? t.foreground : isMatch ? t.ansi3 : t.foreground).child(line || " "));
    };

    const thumbH = fixed ? Math.max(28, Math.round((height / total) * height)) : 0;
    const thumbTop = fixed && maxScroll > 0 ? Math.round((this.scroll / maxScroll) * (height - thumbH)) : 0;
    const pct = this.lines.length > 1 ? Math.round((this.cursor / (this.lines.length - 1)) * 100) : 100;

    return v_flex()
      .id("scrollback")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      // Top header bar
      .child(v_flex().flex_none().px(18).py(12).gap(8).bg(t.surface).border_b(1).border_color(t.border)
        .child(h_flex().gap(10).items_center()
          .child(div().px(8).py(2).rounded(5).bg(`${t.accent}22`).border_1().border_color(`${t.accent}88`).text_color(t.accent).font_semibold().text_size(12).child("COPY / 捲動檢視模式"))
          .child(div().font_semibold().text_size(13.5).child(`${this.title} (${this.terminal ?? "-"})`))
          .when(Boolean(this.cwd), (e) => e.child(div().text_size(12).text_color(t.muted).truncate().child(this.cwd)))
          .child(div().flex_1())
          .when(this.markLine !== null, (e) => e.child(div().px(8).py(2).rounded(5).bg(`${t.ansi2}22`).border_1().border_color(`${t.ansi2}88`).text_color(t.ansi2).text_size(12)
            .child(`已選取第 ${selStart + 1}～${selEnd + 1} 行 (${selEnd - selStart + 1} 行) · 按 y 複製`)))
          .child(div().font_family(MONO).text_size(12).text_color(t.muted).child(`第 ${this.cursor + 1} / ${this.lines.length} 行 (${pct}%)`))
          .child(div().id("sb-copy-all").px(9).py(3).rounded(6).border_1().border_color(t.border).bg(t.raised).cursor_pointer().text_size(12)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.copySelection(cx, true)).child("複製全部 [Y]"))
          .child(div().id("sb-close").px(9).py(3).rounded(6).border_1().border_color(t.border).bg(t.raised).cursor_pointer().text_size(12)
            .hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("離開 [q / Esc]")))
        .child(h_flex().gap(10).items_center()
          .child(h_flex().id("sb-search-box").flex_1().h(30).px(10).gap(8).items_center().rounded(6).bg(t.background).border_1().border_color(this.searching ? t.accent : t.border)
            .on_mouse_down("left", (_e, cx) => { this.searching = true; cx.stop_propagation(); cx.notify(); })
            .child(div().text_color(t.muted).font_family(MONO).child("/"))
            .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
            .when(Boolean(this.query.trim()), (e) => e.child(div().text_size(11.5).text_color(this.matches.length ? t.ansi3 : t.blocked)
              .child(this.matches.length ? `${this.matchIdx + 1} / ${this.matches.length} 筆命中 (n / N 跳轉)` : "無符合結果"))))
          .child(div().flex_none().text_size(11.5).text_color(t.dim)
            .child("j/k 單行 · u/d 半頁 · b/f 整頁 · g/G 頂/底 · v 範圍選取 · y 複製 · / 搜尋 · q 離開"))))
      // Scrollable terminal lines body
      .child(div().id("sb-body").flex_1().min_h(0).relative().px(4).py(4)
        .on_size_change((size, cx) => {
          const h = Math.max(200, Math.floor(size.height - 8));
          if (Math.abs(h - this.viewH) > 4) {
            this.viewH = h;
            this.ensureVisible(false);
            cx.notify();
          }
        })
        .when(this.loading, (e) => e.child(div().p(20).text_color(t.muted).child("正在讀取終端機歷史輸出…")))
        .when(Boolean(this.error), (e) => e.child(div().p(20).text_color(t.blocked ?? t.ansi1).child(this.error)))
        .when(!this.loading && !this.error, (e) => e.child(
          v_flex().id("sb-viewport").relative().h(height).w_full().overflow_hidden()
            .on_scroll_wheel((ev, cx) => {
              this.scroll = Math.max(0, Math.min(this.scroll - ev.delta.y, maxScroll));
              while (this.cursor < this.lines.length - 1 && this.cursor * ROW_H < this.scroll) this.cursor++;
              while (this.cursor > 0 && (this.cursor + 1) * ROW_H > this.scroll + height) this.cursor--;
              cx.notify();
            })
            .children(this.lines.map((line, idx) => visible(idx) ? placeRow(renderRow(line, idx), idx) : null).filter(Boolean))
            .when(fixed, (el) => el.child(div().absolute().right(3).top(thumbTop).w(5).h(thumbH).rounded(3).bg(t.border)))
        )));
  }
}
