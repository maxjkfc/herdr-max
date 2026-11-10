import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec, shared, setShared, openOverlay } from "herdr";

// A GUI-launched app may not have Homebrew on PATH: add both Homebrew prefixes
// (Apple Silicon and Intel) after the inherited PATH instead of naming one install path.
const MACMON_CMD = 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; macmon pipe -s 1 -i 500 --soc-info';

function levelColor(t, val, warnAt, dangerAt) {
  if (val >= dangerAt) return t.blocked;
  if (val >= warnAt) return t.warning ?? t.working;
  return t.foreground;
}

function diskColor(t, freeGb) {
  if (freeGb <= 15) return t.blocked;
  if (freeGb <= 35) return t.warning ?? t.working;
  return t.foreground;
}

export default class WorkspaceStatusPlus extends View {
  init(_props, cx) {
    this.stats = null;
    this.busy = false;
    this.last = 0;
    this.refreshAt = shared("sys.refresh") ?? 0;
    this.poll(cx);
    // One-second tick; the interval (settings popup, `sys.interval`) decides when to poll.
    cx.timer.every(1000, (cx) => {
      // A macmon/df call that never returns must not freeze the readout forever.
      if (this.busy && Date.now() - this.last > 10000) this.busy = false;
      const every = shared("sys.interval") ?? 8000;
      if (every > 0 && window()?.active && Date.now() - this.last >= every) this.poll(cx);
    });
  }

  poll(cx) {
    if (this.busy) return;
    this.busy = true;
    this.last = Date.now();
    cx.spawn(async (cx) => {
      try {
        const [m, d] = await Promise.all([
          exec("sh", ["-c", MACMON_CMD]),
          exec("df", ["-k", "/System/Volumes/Data"]),
        ]);
        const j = JSON.parse(m.stdout.trim().split("\n")[0]);
        const row = d.stdout.trim().split("\n").pop().trim().split(/\s+/);
        const GB = 1024 ** 3;
        const memTotal = j.memory.ram_total / GB;
        const memUsed = j.memory.ram_usage / GB;
        const pct = (x) => Math.round((x ?? 0) * 100);
        this.stats = {
          cpu: Math.min(100, pct(j.cpu_usage_pct)),
          gpu: pct(j.gpu_usage?.[1]),
          temp: Math.round(j.temp?.cpu_temp_avg ?? 0),
          memUsed: memUsed.toFixed(1),
          memTotal: Math.round(memTotal),
          memPct: Math.round((memUsed / memTotal) * 100),
          diskFree: Math.round((Number(row[3]) * 1024) / GB),
        };
        // Everything the details popup shows, for any mod to read.
        setShared("sys.stats", {
          at: Date.now(),
          soc: j.soc ?? null,
          ...this.stats,
          gpuTemp: Math.round(j.temp?.gpu_temp_avg ?? 0),
          ecpu: { pct: pct(j.ecpu_scaled_ratio), mhz: Math.round(j.ecpu_freq_mhz ?? 0), cores: (j.ecpu_cores ?? []).map((c) => pct(c.scaled_ratio)) },
          pcpu: { pct: pct(j.pcpu_scaled_ratio), mhz: Math.round(j.pcpu_freq_mhz ?? 0), cores: (j.pcpu_cores ?? []).map((c) => pct(c.scaled_ratio)) },
          gpuMhz: Math.round(j.gpu_freq_mhz ?? 0),
          power: { cpu: j.cpu_power ?? 0, gpu: j.gpu_power ?? 0, ane: j.ane_power ?? 0, all: j.all_power ?? 0, sys: j.sys_power ?? 0 },
          fans: (j.fans ?? []).map((f) => ({ name: f.name, rpm: f.rpm, max: f.max_rpm })),
          swapUsed: ((j.memory.swap_usage ?? 0) / GB).toFixed(1),
          swapTotal: ((j.memory.swap_total ?? 0) / GB).toFixed(1),
          diskTotal: Math.round((Number(row[1]) * 1024) / GB),
          diskUsed: Math.round((Number(row[2]) * 1024) / GB),
        });
        cx.notify();
      } catch {}
      this.busy = false;
    });
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = {
      cmd: mac ? "⌘" : "Ctrl+",
      ctrl: mac ? "⌃" : "Ctrl+",
      shift: mac ? "⇧" : "Shift+",
      alt: mac ? "⌥" : "Alt+",
      option: mac ? "⌥" : "Alt+",
    };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts =
      b && b.keys.endsWith("--")
        ? [...b.keys.slice(0, -2).split("-"), "-"]
        : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    // The popup's "refresh now" button bumps `sys.refresh`.
    const req = shared("sys.refresh") ?? 0;
    if (req !== this.refreshAt) { this.refreshAt = req; this.poll(cx); }
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const finished = list.filter((a) => a.status === "done").length;
    const st = this.stats;
    const label = (icon, text) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
        .child(text);

    return h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.5)
      .text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) =>
            el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))
          )
          .when(finished > 0, (el) =>
            el.child(div().text_color(t.done).child(`· ${finished} done`))
          )
      )
      .child(div().flex_1())
      .when(Boolean(st), (el) =>
        el.child(
          h_flex()
            .id("sys-stats")
            .gap(14)
            .items_center()
            .cursor_pointer()
            .tooltip("點擊查看系統資源詳細資訊與刷新設定")
            .on_click(() => openOverlay({ mod: "system-monitor", kind: "popup", width: 380, height: 460 }))
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(div().text_color(t.dim).child("CPU"))
                .child(
                  div()
                    .font_semibold()
                    .text_color(levelColor(t, st.cpu, 70, 90))
                    .child(`${st.cpu}%`)
                )
            )
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(div().text_color(t.dim).child("GPU"))
                .child(
                  div()
                    .font_semibold()
                    .text_color(levelColor(t, st.gpu, 70, 90))
                    .child(`${st.gpu}%`)
                )
            )
            .when(st.temp > 0, (el) =>
              el.child(
                h_flex()
                  .gap(4)
                  .items_center()
                  .child(div().text_color(t.dim).child("TEMP"))
                  .child(
                    div()
                      .font_semibold()
                      .text_color(levelColor(t, st.temp, 80, 95))
                      .child(`${st.temp}°C`)
                  )
              )
            )
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(div().text_color(t.dim).child("RAM"))
                .child(
                  div()
                    .font_semibold()
                    .text_color(levelColor(t, st.memPct, 80, 92))
                    .child(`${st.memUsed}/${st.memTotal}G`)
                )
                .child(div().text_size(10.5).text_color(t.dim).child(`(${st.memPct}%)`))
            )
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .child(div().text_color(t.dim).child("SSD"))
                .child(
                  div()
                    .font_semibold()
                    .text_color(diskColor(t, st.diskFree))
                    .child(`剩 ${st.diskFree}G`)
                )
            )
        )
      )
      .child(div().w(1).h(12).bg(t.border))
      .child(
        div()
          .id("palette")
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("app.palette"))
          .child(this.hint())
      );
  }
}
