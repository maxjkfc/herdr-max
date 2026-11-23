// Sidebar block: uptime, load, RAM and disk of the machines you pick (`hc machine ls`), read over
// herdr-core with `exec(..., { on })`. The gear in the header opens the picker; the list is saved in
// `shared("machine-monitor.machines")`. Only the picked machines are ever polled. Clicking a row opens
// a details popup for that machine (load history, RAM / disk figures, busiest processes), refreshed
// every 5s while it is open.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, machines, notify, openOverlay, props, run, setShared, shared, theme, window } from "herdr";
import { RANGES, limitsOf, step } from "./alerts.js";
import { DETAIL_PROBE, PROBE, fmtUptime, parseDetail, parseProbe, watchedList } from "./probe.js";

const KEY = "machine-monitor.machines";
const ALERT_KEY = "machine-monitor.alerts"; // localStorage: name → { disk, uptime } already notified
const LIMITS_KEY = "machine-monitor.limits"; // shared: { diskPct, uptimeDays, pollSec }, set in the ⚙ picker
const TICK_MS = 5_000;
const TIMEOUT_MS = 15_000;
const HEADER_PX = 28;
const ROW_PX = 42; // two text lines and padding
const MAX_ROWS = 6; // the block stops growing here and scrolls, so it never squeezes the Spaces / Agents lists out
const DETAIL_MS = 5_000;

// Green / amber / red; not every theme defines `warning`, `working` is Herdr's amber.
const tone = (t, v, warn, danger) => (v >= danger ? t.blocked : v >= warn ? t.warning ?? t.working : t.done);
const limits = () => limitsOf(shared(LIMITS_KEY));
// Amber once a machine has been up for the limit's days, else null (the caller's default color).
const upWarn = (t, sec) => (sec >= limits().uptimeDays * 86400 ? t.warning ?? t.working : null);
// SSD: amber from 12 points under the limit (80% at the default 92%), red at it.
const diskTone = (t, pct) => { const d = limits().diskPct; return tone(t, pct, d - 12, d); };
// The same on the 80 / 92 scale `tone` uses elsewhere, to rank the SSD beside load and RAM.
const diskLevel = (pct) => { const d = limits().diskPct; return pct >= d ? 100 : pct >= d - 12 ? 85 : 0; };

const registered = () => machines().map((m) => m.name).filter(Boolean);

export default class MachineMonitor extends View {
  init(_props, cx) {
    this.state = new Map(); // name → { busy, at (last poll start), stats, error }
    if (props()?.machine) {
      this.handle = cx.focus_handle();
      cx.timer.after(40, () => this.handle.focus());
      this.detail = { busy: false, at: 0, stats: null, info: null, error: null };
      this.fetchDetail(cx);
      cx.timer.every(DETAIL_MS, (cx) => this.fetchDetail(cx));
      return;
    }
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
      if (st?.busy || (st && Date.now() - st.at < limits().pollSec * 1000)) continue;
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
        if (stats) { st.stats = stats; st.error = null; this.alert(name, stats); }
        else { st.stats = null; st.error = r.stderr.trim().split("\n").pop() || r.stdout.match(/^error=(.*)$/m)?.[1] || `exit ${r.code}`; }
      } catch (e) {
        st.stats = null;
        st.error = String(e?.message ?? e);
      }
      st.busy = false;
      cx.notify();
    });
  }

  // Notifies when SSD use or uptime crosses its line (alerts.js); what was already notified is kept
  // in localStorage, so a restart doesn't repeat it.
  alert(name, stats) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(ALERT_KEY) ?? "{}") ?? {}; } catch {}
    const { alerts, state } = step(name, stats, all[name], limits());
    all[name] = state;
    localStorage.setItem(ALERT_KEY, JSON.stringify(all));
    for (const a of alerts) notify({ ...a, level: "warning", timeout: 15000 });
  }

  openPicker() {
    const n = new Set([...registered(), ...(watchedList(shared(KEY)) ?? [])]).size;
    openOverlay({ mod: "machine-monitor", kind: "popup", width: 320, height: 240 + Math.max(n, 1) * 30 });
  }

  openDetail(name) {
    openOverlay({ mod: "machine-monitor", props: { machine: name }, kind: "popup", width: 380, height: 680 });
  }

  fetchDetail(cx) {
    const d = this.detail;
    if (d.busy && Date.now() - d.at < TIMEOUT_MS + 2000) return;
    d.busy = true;
    d.at = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", DETAIL_PROBE], { on: props().machine, timeout: TIMEOUT_MS });
        const stats = parseProbe(r.stdout);
        if (stats) { d.stats = stats; d.info = parseDetail(r.stdout); d.error = null; }
        else { d.stats = null; d.info = null; d.error = r.stderr.trim().split("\n").pop() || r.stdout.match(/^error=(.*)$/m)?.[1] || `exit ${r.code}`; }
      } catch (e) {
        d.stats = null;
        d.info = null;
        d.error = String(e?.message ?? e);
      }
      d.busy = false;
      d.doneAt = Date.now();
      cx.notify();
    });
  }

  bar(t, pct, color, h = 5) {
    const p = Math.max(0, Math.min(100, pct));
    return div().h(h).w_full().rounded(h / 2).bg(t.input).overflow_hidden()
      .child(div().h(h).w(`${Math.max(p, 2)}%`).rounded(h / 2).bg(color));
  }

  tile(t, label, value, unit, pct, color) {
    return v_flex().flex_1().min_w(0).gap(3).p(8).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).font_semibold().child(label))
      .child(h_flex().items_end().gap(2)
        .child(div().text_size(22).font_bold().text_color(color).child(value))
        .child(div().text_size(11).text_color(t.dim).pb(3).child(unit)))
      .child(this.bar(t, pct, color));
  }

  card(t, title, ...rows) {
    return v_flex().gap(3).p(8).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).font_semibold().child(title))
      .children(rows);
  }

  line(t, name, value, color) {
    return h_flex().items_center().justify_between().h(16)
      .child(div().text_color(t.muted).child(name))
      .child(div().font_semibold().text_color(color ?? t.foreground).child(value));
  }

  procCard(t, title, list) {
    const col = (text, color) => div().w(46).flex_none().flex().justify_end().text_color(color ?? t.foreground).child(text);
    return this.card(t, title,
      ...(list.length
        ? list.map((p, i) => h_flex().id(`mm-p-${title}-${i}`).items_center().h(16).gap(6)
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(p.name))
          .child(col(`${p.cpu.toFixed(1)}%`, tone(t, p.cpu, 60, 90)))
          .child(col(`${p.mem.toFixed(1)}%`, tone(t, p.mem, 20, 40))))
        : [div().text_size(11).text_color(t.dim).child("沒有資料（這台的 ps 不支援）")]));
  }

  renderDetail(t) {
    const name = props().machine;
    const d = this.detail;
    const s = d.stats, info = d.info;
    const close = () => closeOverlay(props()?.overlay);
    const frame = v_flex().id("mm-detail").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" || e.key === "q") { cx.stop_propagation(); close(); }
        else if (e.key === "r") { cx.stop_propagation(); this.fetchDetail(cx); }
      })
      .size_full().p(12).gap(8).bg(t.popover).text_color(t.foreground).text_size(12);
    const sub = s ? [s.os, info?.kernel, info?.host].filter(Boolean).join(" · ") : d.busy ? "讀取中…" : "無法連線";
    const head = h_flex().items_center().justify_between()
      .child(v_flex().gap(1).min_w(0)
        .child(div().text_size(15).font_bold().child(name))
        .child(div().text_size(11).text_color(t.dim).truncate().child(sub)))
      .child(div().id("mm-refresh").flex_none().px(10).py(4).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .text_size(11).cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.fetchDetail(cx)).child("↻ 刷新"));
    if (!s) {
      return frame.child(head).child(div().text_size(11).text_color(d.error ? t.blocked : t.dim).child(d.error ? `無法連線 · ${d.error}` : "讀取中…"));
    }
    const b = new Date(Date.now() - s.upSec * 1000);
    const p2 = (n) => String(n).padStart(2, "0");
    const since = `${b.getFullYear()}-${p2(b.getMonth() + 1)}-${p2(b.getDate())} ${p2(b.getHours())}:${p2(b.getMinutes())}`;
    const gb = (v) => `${v.toFixed(1)}G`;
    const body = v_flex().id("mm-detail-body").flex_none().max_h(540).overflow_y_scrollbar().gap(8)
      .child(h_flex().gap(8)
        .child(this.tile(t, "Load", s.load[0].toFixed(2), `/ ${s.cores} 核`, s.loadPerCore * 100, tone(t, s.loadPerCore * 100, 70, 100)))
        .child(this.tile(t, "RAM", s.memPct, "%", s.memPct, tone(t, s.memPct, 80, 92)))
        .child(this.tile(t, "SSD", s.diskPct, "%", s.diskPct, diskTone(t, s.diskPct))))
      .child(this.card(t, "運行",
        this.line(t, "已運行", fmtUptime(s.upSec), upWarn(t, s.upSec)),
        this.line(t, "開機時間", since),
        this.line(t, "負載 1 / 5 / 15 分", s.load.map((x) => x.toFixed(2)).join(" / "))))
      .child(this.card(t, "記憶體 · 磁碟",
        this.line(t, "RAM 已用", `${gb(s.memUsedGb)} / ${gb(s.memTotalGb)}`, tone(t, s.memPct, 80, 92)),
        this.line(t, "SSD 已用", `${gb(s.diskTotalGb - s.diskFreeGb)} / ${gb(s.diskTotalGb)}`, diskTone(t, s.diskPct)),
        this.line(t, "SSD 剩餘", gb(s.diskFreeGb))))
      .child(this.procCard(t, "CPU 前五", info?.topCpu ?? []))
      .child(this.procCard(t, "記憶體前五", info?.topMem ?? []));
    const foot = div().flex_none().text_size(10).text_color(t.dim)
      .child(`每 ${DETAIL_MS / 1000} 秒更新 · ${d.doneAt ? new Date(d.doneAt).toLocaleTimeString("zh-TW", { hour12: false }) : ""} · Esc 關閉`);
    return frame.child(head).child(body).child(foot);
  }

  machineRow(t, name, st) {
    const s = st?.stats;
    const dot = s ? tone(t, Math.max(s.loadPerCore * 100, s.memPct, diskLevel(s.diskPct)), 80, 92) : st?.busy || !st ? t.dim : t.blocked;
    const metric = (label, value, color) => h_flex().gap(3).flex_none()
      .child(div().text_color(t.dim).child(label))
      .child(div().text_color(color).child(value));
    return v_flex().id(`mm-${name}`).gap(2).px(12).py(4).cursor_pointer().hover((x) => x.bg(t.hover)).on_click(() => this.openDetail(name))
      .tooltip(s ? `${name} · ${s.os} · ${s.cores} cores · load ${s.load.join(" / ")} · RAM ${s.memTotalGb.toFixed(0)}G · SSD 剩 ${s.diskFreeGb.toFixed(0)}G` : st?.error ?? "讀取中…")
      .child(h_flex().items_center().gap(6)
        .child(div().size(6).rounded(3).flex_none().bg(dot))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(name))
        .child(div().flex_none().text_size(10.5).text_color((s && upWarn(t, s.upSec)) || t.dim).child(s ? `up ${fmtUptime(s.upSec)}` : "")))
      .child(s
        ? h_flex().gap(10).pl(12).text_size(10.5)
          .child(metric("Load", s.load[0].toFixed(2), tone(t, s.loadPerCore * 100, 70, 100)))
          .child(metric("RAM", `${s.memPct}%`, tone(t, s.memPct, 80, 92)))
          .child(metric("SSD", `${s.diskPct}%`, diskTone(t, s.diskPct)))
        : div().pl(12).text_size(10.5).text_color(st && !st.busy ? t.blocked : t.dim).truncate().child(st && !st.busy ? `無法連線 · ${st.error ?? ""}` : "讀取中…"));
  }

  // The block is as tall as its machines (header + a row each, or one line of hint when none are watched).
  syncHeight(count) {
    if (count === this.lastCount) return;
    this.lastCount = count;
    const px = HEADER_PX + (count ? Math.min(count, MAX_ROWS) * ROW_PX : 28) + 6;
    run("layout.resize", { id: "machines", px });
  }

  renderSidebar(t) {
    const watched = watchedList(shared(KEY)) ?? [];
    this.syncHeight(watched.length);
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

  // `−n … value … +n` row for one number of LIMITS_KEY.
  stepper(t, key, label, unit, deltas) {
    const lim = limits();
    const [lo, hi] = RANGES[key];
    const set = (v) => setShared(LIMITS_KEY, { ...lim, [key]: Math.min(hi, Math.max(lo, v)) });
    const btn = (d) => div().id(`mm-${key}-${d}`).w(28).h(22).flex().items_center().justify_center().rounded(5)
      .bg(t.surface).border_1().border_color(t.border).text_size(11).cursor_pointer().hover((x) => x.bg(t.hover))
      .on_click(() => set(lim[key] + d)).child(d > 0 ? `+${d}` : `${d}`);
    return h_flex().items_center().gap(4).px(8)
      .child(div().flex_1().text_color(t.muted).child(label))
      .children(deltas.filter((d) => d < 0).map(btn))
      .child(div().w(50).flex().justify_center().font_semibold().child(`${lim[key]}${unit}`))
      .children(deltas.filter((d) => d > 0).map(btn));
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
      .child(div().mt(6).text_size(11).text_color(t.dim).child("警告通知的門檻"))
      .child(this.stepper(t, "diskPct", "SSD 用量達", "%", [-5, -1, 1, 5]))
      .child(this.stepper(t, "uptimeDays", "開機超過", " 天", [-7, -1, 1, 7]))
      .child(this.stepper(t, "pollSec", "同步間隔", " 秒", [-30, -10, 10, 30]))
      .child(div().id("mm-done").mt(4).h(28).flex().items_center().justify_center().rounded(8).bg(t.surface)
        .border_1().border_color(t.border).font_semibold().cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click(close).child("完成"));
  }

  render(cx) {
    const t = theme();
    return props()?.machine ? this.renderDetail(t) : props()?.overlay ? this.renderPicker(t) : this.renderSidebar(t);
  }
}
