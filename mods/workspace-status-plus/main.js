import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, exec } from "herdr";

const STAT_CMD = `(sysctl -n hw.ncpu hw.memsize; echo "---PS---"; ps -A -o %cpu; echo "---VM---"; vm_stat; echo "---DF---"; df -k /System/Volumes/Data) | awk '
BEGIN { mode="sys"; n=0 }
/^---PS---$/ { mode="ps"; next }
/^---VM---$/ { mode="vm"; next }
/^---DF---$/ { mode="df"; next }
mode=="sys" { n++; if (n==1) ncpu=$1; if (n==2) mem_total=$1 }
mode=="ps" && $1 ~ /^[0-9]/ { cpu_sum += $1 }
mode=="vm" && /page size of/ { for(i=1;i<=NF;i++) if($i=="of") psize=$(i+1)+0 }
mode=="vm" && /^Anonymous pages:/ { anon=$NF+0 }
mode=="vm" && /^Pages wired down:/ { wired=$NF+0 }
mode=="vm" && /^Pages occupied by compressor:/ { comp=$NF+0 }
mode=="df" && $1 ~ /^\\/dev\\// { df_total=$2+0; df_avail=$4+0 }
END {
  if (!psize) psize=16384
  cpu = int((cpu_sum / (ncpu > 0 ? ncpu : 1)) + 0.5)
  if (cpu > 100) cpu = 100
  mem_total_gb = mem_total / (1024*1024*1024)
  mem_used_gb = ((anon + wired + comp) * psize) / (1024*1024*1024)
  mem_pct = mem_total_gb > 0 ? int((mem_used_gb / mem_total_gb)*100 + 0.5) : 0
  disk_free_gb = int((df_avail * 1024) / (1024*1024*1024) + 0.5)
  printf "{\\"cpu\\":%d,\\"memUsed\\":%.1f,\\"memTotal\\":%.0f,\\"memPct\\":%d,\\"diskFree\\":%d}\\n", cpu, mem_used_gb, mem_total_gb, mem_pct, disk_free_gb
}'`;

function levelColor(t, val, warnAt, dangerAt) {
  if (val >= dangerAt) return t.blocked;
  if (val >= warnAt) return t.warning;
  return t.foreground;
}

function diskColor(t, freeGb) {
  if (freeGb <= 15) return t.blocked;
  if (freeGb <= 35) return t.warning;
  return t.foreground;
}

export default class WorkspaceStatusPlus extends View {
  init(_props, cx) {
    this.stats = null;
    this.busy = false;
    this.poll(cx);
    cx.timer.every(8000, (cx) => {
      if (window()?.active) this.poll(cx);
    });
  }

  poll(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", STAT_CMD]);
        if (r.code === 0 && r.stdout.trim()) {
          this.stats = JSON.parse(r.stdout.trim());
          cx.notify();
        }
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

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
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
      )
      .child(div().flex_1())
      .when(Boolean(st), (el) =>
        el.child(
          h_flex()
            .id("sys-stats")
            .gap(14)
            .items_center()
            .cursor_pointer()
            .tooltip("點擊立即刷新系統資源狀態 (前台每 8 秒更新一次，背景自動暫停)")
            .on_click((_e, cx) => this.poll(cx))
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
