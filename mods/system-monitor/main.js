// Details popup for the status bar's CPU / GPU / RAM / SSD readout.
// Reads `sys.stats` (written by workspace-status-plus) and sets `sys.interval`
// (ms between polls; 0 = manual) and `sys.refresh` (bumped to refresh now).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, exec, props, run, setShared, shared, theme } from "herdr";

// Local, Tailscale and public IPv4. The public one asks api.ipify.org, so it is
// fetched only when this popup opens or is refreshed, never on the status poll.
const NET_CMD = `export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/Applications/Tailscale.app/Contents/MacOS"
IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
echo "lan=$(ipconfig getifaddr "$IF" 2>/dev/null)"
echo "if=$IF"
echo "ts=$(tailscale ip -4 2>/dev/null | head -1)"
echo "pub=$(curl -s -m 4 https://api.ipify.org 2>/dev/null)"`;

const INTERVALS = [
  [2000, "2s"],
  [5000, "5s"],
  [8000, "8s"],
  [15000, "15s"],
  [30000, "30s"],
  [0, "手動"],
];

// Green / amber / red by load.
const tone = (t, v, warn, danger) => (v >= danger ? t.blocked : v >= warn ? t.warning : t.done);

export default class SystemMonitor extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.net = null;
    this.fetchNet(cx);
    cx.timer.after(40, () => this.handle.focus());
  }

  fetchNet(cx) {
    if (this.netBusy) return;
    this.netBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", NET_CMD]);
        const net = {};
        for (const line of r.stdout.split("\n")) {
          const i = line.indexOf("=");
          if (i > 0) net[line.slice(0, i)] = line.slice(i + 1).trim();
        }
        this.net = net;
      } catch { this.net = {}; }
      this.netBusy = false;
      cx.notify();
    });
  }

  refreshAll(cx) {
    setShared("sys.refresh", Date.now());
    this.fetchNet(cx);
  }

  bar(t, pct, color, h = 5) {
    const p = Math.max(0, Math.min(100, pct));
    return div().h(h).w_full().rounded(h / 2).bg(t.input).overflow_hidden()
      .child(div().h(h).w(`${Math.max(p, 2)}%`).rounded(h / 2).bg(color));
  }

  // A big-number tile: label, value, thin bar.
  tile(t, label, value, unit, pct, color) {
    return v_flex().flex_1().min_w(0).gap(4).p(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).font_semibold().child(label))
      .child(h_flex().items_end().gap(2)
        .child(div().text_size(22).font_bold().text_color(color).child(value))
        .child(div().text_size(11).text_color(t.dim).pb(3).child(unit)))
      .child(this.bar(t, pct, color));
  }

  card(t, title, ...rows) {
    return v_flex().gap(6).p(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).font_semibold().child(title))
      .children(rows);
  }

  line(t, name, value, color) {
    return h_flex().items_center().justify_between().h(18)
      .child(div().text_color(t.muted).child(name))
      .child(div().font_semibold().text_color(color ?? t.foreground).child(value));
  }

  ipLine(t, name, value, ok) {
    return h_flex().items_center().gap(8).h(20)
      .child(div().size(6).rounded(3).flex_none().bg(ok ? t.done : t.dim))
      .child(div().flex_1().text_color(t.muted).child(name))
      .child(div().font_semibold().text_color(ok ? t.foreground : t.dim).child(value));
  }

  render(cx) {
    const t = theme();
    const s = shared("sys.stats");
    const every = shared("sys.interval") ?? 8000;
    const close = () => closeOverlay(props()?.overlay);

    const frame = v_flex().id("system-monitor").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" || e.key === "q") { cx.stop_propagation(); close(); }
        else if (e.key === "r") { cx.stop_propagation(); this.refreshAll(cx); }
      })
      .size_full().p(12).gap(8).bg(t.popover).text_color(t.foreground).text_size(12);

    const head = h_flex().items_center().justify_between()
      .child(v_flex().gap(1)
        .child(div().text_size(15).font_bold().child(s?.soc?.chip_name ?? "System"))
        .child(div().text_size(11).text_color(t.dim).child(s
          ? `${s.soc?.mac_model ?? ""} · ${new Date(s.at).toLocaleTimeString("zh-TW", { hour12: false })}`
          : "讀取中…")))
      .child(div().id("sm-refresh").px(10).py(4).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .text_size(11).cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => this.refreshAll(cx)).child("↻ 刷新"));

    const segmented = h_flex().items_center().justify_between()
      .child(div().text_size(11).text_color(t.dim).child("自動刷新"))
      .child(h_flex().gap(4).children(INTERVALS.map(([ms, label]) =>
        div().id(`sm-int-${ms}`).px(9).py(3).rounded(6).text_size(11).cursor_pointer()
          .border_1().border_color(every === ms ? t.accent : t.border)
          .bg(every === ms ? t.selected : t.surface)
          .text_color(every === ms ? t.foreground : t.muted)
          .hover((x) => x.bg(t.hover))
          .on_click(() => setShared("sys.interval", ms)).child(label))));

    const ip = (v, none) => v || (this.net ? none : "查詢中…");
    const network = this.card(t, `網路${this.net?.if ? ` · ${this.net.if}` : ""}`,
      this.ipLine(t, "內部 IP", ip(this.net?.lan, "未連線"), Boolean(this.net?.lan)),
      this.ipLine(t, "Tailscale", ip(this.net?.ts, "未啟用"), Boolean(this.net?.ts)),
      this.ipLine(t, "對外 IP", ip(this.net?.pub, "無法取得"), Boolean(this.net?.pub)));

    if (!s) return frame.child(head).child(segmented).child(network);

    const fan = (s.fans ?? []).map((f) => f.rpm).join(" / ");
    const hot = Math.max(s.temp, s.gpuTemp);
    const diskColor = s.diskFree <= 15 ? t.blocked : s.diskFree <= 35 ? t.warning : t.done;

    // Head and the refresh control stay pinned; the readouts scroll if the window is short.
    const body = v_flex().id("sm-body").flex_none().max_h(310).overflow_y_scrollbar().gap(8)
      .child(h_flex().gap(8)
        .child(this.tile(t, "CPU", s.cpu, "%", s.cpu, tone(t, s.cpu, 70, 90)))
        .child(this.tile(t, "GPU", s.gpu, "%", s.gpu, tone(t, s.gpu, 70, 90)))
        .child(this.tile(t, "RAM", s.memUsed, `/${s.memTotal}G`, s.memPct, tone(t, s.memPct, 80, 92))))
      .child(this.card(t, "儲存與狀態",
        this.line(t, "SSD", `剩 ${s.diskFree}G / ${s.diskTotal}G`, diskColor),
        this.bar(t, s.diskTotal ? (s.diskUsed / s.diskTotal) * 100 : 0, diskColor, 4),
        this.line(t, "溫度", `CPU ${s.temp}° · GPU ${s.gpuTemp}°`, tone(t, hot, 80, 95)),
        this.line(t, "功耗", `整機 ${s.power.sys.toFixed(1)}W`),
        ...(fan && s.fans.some((f) => f.rpm > 0) ? [this.line(t, "風扇", `${fan} rpm`)] : [])))
      .child(network);
    const launcher = (id, label, on) => div().id(id).flex_1().h(28).flex().items_center().justify_center().rounded(8)
      .bg(t.surface).border_1().border_color(t.border).text_size(12).font_semibold().cursor_pointer()
      .hover((x) => x.bg(t.hover)).on_click(() => { on(); close(); }).child(label);
    const tools = h_flex().gap(8)
      .child(launcher("sm-activity", "↗ 活動監視器", () => exec("open", ["-a", "Activity Monitor"])))
      .child(launcher("sm-macmon", "▸ macmon（終端機）", () => run("terminal.open", { argv: ["/opt/homebrew/bin/macmon"], place: "tab" })));
    return frame.child(head).child(segmented).child(body).child(tools);
  }
}
