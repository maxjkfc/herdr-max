// What the machine-monitor mod asks of a machine, and how it reads the answer. Pure: no herdr imports,
// so tests can load it.

// Runs on the monitored machine (`exec(..., { on })`), POSIX sh, Linux or macOS. Prints `key=value` lines:
// up (s), cores, load (1/5/15 min), memtotal / memavail (kB), disktotal / diskavail (kB of the main volume).
// macOS has no "available" figure: free + inactive + speculative pages stand in for it, so it reads a bit
// lower than Activity Monitor's "Memory Used" on a machine with lots of purgeable cache.
export const PROBE = String.raw`
os=$(uname -s)
echo "os=$os"
case "$os" in
Linux)
  echo "up=$(cut -d. -f1 /proc/uptime)"
  echo "cores=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo)"
  echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
  awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print "memtotal=" t; print "memavail=" a}' /proc/meminfo
  vol=/
  ;;
Darwin)
  boot=$(sysctl -n kern.boottime | sed -n 's/^{ *sec = \([0-9]*\),.*/\1/p')
  echo "up=$(( $(date +%s) - boot ))"
  echo "cores=$(sysctl -n hw.ncpu)"
  echo "load=$(sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1, $2, $3}')"
  echo "memtotal=$(( $(sysctl -n hw.memsize) / 1024 ))"
  vm_stat | awk '
    /page size of/ { gsub(/[^0-9]/, "", $8); ps = $8 }
    /^Pages free/ { f = $3 } /^Pages inactive/ { i = $3 } /^Pages speculative/ { s = $3 }
    END { printf "memavail=%d\n", (f + i + s) * ps / 1024 }'
  vol=/System/Volumes/Data
  [ -d "$vol" ] || vol=/
  ;;
*)
  echo "error=unsupported $os"
  exit 0
  ;;
esac
df -Pk "$vol" | awk 'NR==2{print "disktotal=" $2 + 0; print "diskavail=" $4 + 0}'
`;

// The details popup runs PROBE plus this: hostname, kernel and the five busiest processes by CPU and by
// memory (`topcpu=` / `topmem=` lines of `cpu%|mem%|name`). Only when the popup is open, not on every poll.
export const DETAIL_PROBE = PROBE + String.raw`
echo "host=$(hostname)"
echo "kernel=$(uname -r)"
procs=$(ps -eo pcpu=,pmem=,comm= 2>/dev/null | awk '{c=$1; m=$2; $1=$2=""; sub(/^ +/, ""); n=$0; sub(/.*\//, "", n); print c "|" m "|" n}')
echo "$procs" | sort -t'|' -k1,1 -rn | head -5 | sed 's/^/topcpu=/'
echo "$procs" | sort -t'|' -k2,2 -rn | head -5 | sed 's/^/topmem=/'
`;

// Host, kernel and process lists from DETAIL_PROBE's output; lists are empty when `ps` gave nothing.
export function parseDetail(stdout) {
  const out = { host: "", kernel: "", topCpu: [], topMem: [] };
  const proc = (s) => {
    const [cpu, mem, ...name] = s.split("|");
    return Number.isFinite(Number(cpu)) && Number.isFinite(Number(mem)) && name.length ? { cpu: Number(cpu), mem: Number(mem), name: name.join("|") } : null;
  };
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.startsWith("host=")) out.host = line.slice(5).trim();
    else if (line.startsWith("kernel=")) out.kernel = line.slice(7).trim();
    else if (line.startsWith("topcpu=")) { const p = proc(line.slice(7)); if (p) out.topCpu.push(p); }
    else if (line.startsWith("topmem=")) { const p = proc(line.slice(7)); if (p) out.topMem.push(p); }
  }
  return out;
}

const num = (v) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : null;
};

// The probe's output as numbers, or null when it is missing something the readout needs.
export function parseProbe(stdout) {
  const kv = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const up = num(kv.up), cores = num(kv.cores), memTotal = num(kv.memtotal), memAvail = num(kv.memavail);
  const diskTotal = num(kv.disktotal), diskAvail = num(kv.diskavail);
  const load = (kv.load ?? "").split(/\s+/).map(Number);
  if ([up, cores, memTotal, memAvail, diskTotal, diskAvail].includes(null) || cores < 1 || memTotal <= 0 || diskTotal <= 0) return null;
  if (load.length !== 3 || load.some((x) => !Number.isFinite(x))) return null;
  const KB_GB = 1024 * 1024;
  return {
    os: kv.os ?? "",
    upSec: up,
    cores,
    load,
    // Load per core: 1.0 = every core busy on average over the last minute.
    loadPerCore: load[0] / cores,
    memPct: Math.round(((memTotal - memAvail) / memTotal) * 100),
    memTotalGb: memTotal / KB_GB,
    memUsedGb: (memTotal - memAvail) / KB_GB,
    diskPct: Math.round(((diskTotal - diskAvail) / diskTotal) * 100),
    diskTotalGb: diskTotal / KB_GB,
    diskFreeGb: diskAvail / KB_GB,
  };
}

// Uptime as the two biggest units: "4d 21h", "3h 12m", "5m".
export function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Which machines to watch: the saved list, or null when nothing was saved yet.
export function watchedList(saved) {
  return Array.isArray(saved) ? saved.filter((n) => typeof n === "string" && n) : null;
}
