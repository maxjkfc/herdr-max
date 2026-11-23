// Sidebar block: uptime, load, RAM and disk of the machines you pick (`hc machine ls`), read over
// herdr-core with `exec(..., { on })`. The gear in the header opens the picker; the list is saved in
// `shared("machine-monitor.machines")`. Only the picked machines are ever polled.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, machines, openOverlay, props, setShared, shared, theme, window } from "herdr";
import { PROBE, fmtUptime, parseProbe, watchedList } from "./probe.js";

const KEY = "machine-monitor.machines";
const POLL_MS = 30_000;
const TICK_MS = 5_000;
const TIMEOUT_MS = 15_000;

// Green / amber / red; not every theme defines `warning`, `working` is Herdr's amber.
const tone = (t, v, warn, danger) => (v >= danger ? t.blocked : v >= warn ? t.warning ?? t.working : t.done);

const registered = () => machines().map((m) => m.name).filter(Boolean);

export default class MachineMonitor extends View {
  init(_props, cx) {
    this.state = new Map(); // name → { busy, at (last poll start), stats, error }
    if (props()?.overlay) {
      this.handle = cx.focus_handle();
      cx.timer.after(40, () => this.handle.focus());
      return;
    }
    this.tick(cx);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  // First run: watch the machines registered right now, so the list is explicit from then on.
  seed() {
    if (watchedList(shared(KEY)) !== null) return;
    const names = registered();
    if (names.length) setShared(KEY, names);
  }

  tick(cx) {
    this.seed();
    if (!window()?.active) return;
    const watched = watchedList(shared(KEY)) ?? [];
    for (const name of [...this.state.keys()]) if (!watched.includes(name)) this.state.delete(name);
    for (const name of watched) {
      const st = this.state.get(name);
      if (st?.busy || (st && Date.now() - st.at < POLL_MS)) continue;
      this.poll(name, cx);
    }
  }

  poll(name, cx) {
    const prev = this.state.get(name);
    const st = { busy: true, at: Date.now(), stats: prev?.stats ?? null, error: null };
    this.state.set(name, st);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", PROBE], { on: name, timeout: TIMEOUT_MS });
        const stats = parseProbe(r.stdout);
        if (stats) { st.stats = stats; st.error = null; }
        else { st.stats = null; st.error = r.stderr.trim().split("\n").pop() || r.stdout.match(/^error=(.*)$/m)?.[1] || `exit ${r.code}`; }
      } catch (e) {
        st.stats = null;
        st.error = String(e?.message ?? e);
      }
      st.busy = false;
      cx.notify();
    });
  }

  openPicker() {
    const n = new Set([...registered(), ...(watchedList(shared(KEY)) ?? [])]).size;
    openOverlay({ mod: "machine-monitor", kind: "popup", width: 280, height: 96 + Math.max(n, 1) * 30 });
  }

  machineRow(t, name, st) {
    const s = st?.stats;
    const dot = s ? tone(t, Math.max(s.loadPerCore * 100, s.memPct, s.diskPct), 80, 92) : st?.busy || !st ? t.dim : t.blocked;
    const metric = (label, value, color) => h_flex().gap(3).flex_none()
      .child(div().text_color(t.dim).child(label))
      .child(div().text_color(color).child(value));
    return v_flex().id(`mm-${name}`).gap(2).px(12).py(4)
      .tooltip(s ? `${name} · ${s.os} · ${s.cores} cores · load ${s.load.join(" / ")} · RAM ${s.memTotalGb.toFixed(0)}G · SSD 剩 ${s.diskFreeGb.toFixed(0)}G` : st?.error ?? "讀取中…")
      .child(h_flex().items_center().gap(6)
        .child(div().size(6).rounded(3).flex_none().bg(dot))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(name))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(s ? `up ${fmtUptime(s.upSec)}` : "")))
      .child(s
        ? h_flex().gap(10).pl(12).text_size(10.5)
          .child(metric("Load", s.load[0].toFixed(2), tone(t, s.loadPerCore * 100, 70, 100)))
          .child(metric("RAM", `${s.memPct}%`, tone(t, s.memPct, 80, 92)))
          .child(metric("SSD", `${s.diskPct}%`, tone(t, s.diskPct, 80, 92)))
        : div().pl(12).text_size(10.5).text_color(st && !st.busy ? t.blocked : t.dim).truncate().child(st && !st.busy ? `無法連線 · ${st.error ?? ""}` : "讀取中…"));
  }

  renderSidebar(t) {
    const watched = watchedList(shared(KEY)) ?? [];
    return v_flex().size_full().min_h(0).text_color(t.foreground)
      .child(h_flex().id("mm-header").h(28).flex_none().pl(12).pr(10).items_center().justify_between().text_size(11).text_color(t.dim)
        .child("Machines")
        .child(div().id("mm-pick").px(6).rounded(4).cursor_pointer().hover((x) => x.bg(t.hover)).tooltip("選擇要監控的機器")
          .on_click(() => this.openPicker()).child("⚙")))
      .child(v_flex().id("mm-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(watched.length
          ? watched.map((name) => this.machineRow(t, name, this.state.get(name)))
          : [div().px(12).py(4).text_size(11).text_color(t.dim).child("尚未選擇機器 · 按右上角 ⚙")]));
  }

  renderPicker(t) {
    const watched = watchedList(shared(KEY)) ?? [];
    const names = [...new Set([...registered(), ...watched])];
    const close = () => closeOverlay(props()?.overlay);
    const toggle = (name) => setShared(KEY, names.filter((n) => (n === name ? !watched.includes(n) : watched.includes(n))));
    return v_flex().id("mm-picker").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" || e.key === "enter") { cx.stop_propagation(); close(); } })
      .size_full().p(12).gap(6).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(div().text_size(11).text_color(t.dim).child("監控哪幾台（只會輪詢勾選的）"))
      .children(names.length
        ? names.map((name) => {
            const on = watched.includes(name);
            return h_flex().id(`mm-opt-${name}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
              .hover((x) => x.bg(t.hover)).on_click(() => toggle(name))
              .child(div().text_color(on ? t.accent : t.dim).child(on ? "☑" : "☐"))
              .child(div().flex_1().truncate().child(name));
          })
        : [div().text_size(11).text_color(t.dim).child("沒有已登錄的機器 · hc machine add <ssh 名稱>")])
      .child(div().id("mm-done").mt(4).h(28).flex().items_center().justify_center().rounded(8).bg(t.surface)
        .border_1().border_color(t.border).font_semibold().cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click(close).child("完成"));
  }

  render(cx) {
    const t = theme();
    return props()?.overlay ? this.renderPicker(t) : this.renderSidebar(t);
  }
}
