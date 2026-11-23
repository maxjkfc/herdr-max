// When a watched machine deserves a notification. Pure: no herdr imports, so tests can load it.
//
// Each condition notifies once when it starts to hold and again only after it has cleared:
//   disk   : used % reaches `diskPct`; re-arms once it is DISK_GAP points under it (so a volume
//            hovering around the line doesn't notify on every poll)
//   uptime : up for `uptimeDays` or more; re-arms on the next reboot

export const DEFAULTS = { diskPct: 92, uptimeDays: 28, pollSec: 30 };
export const RANGES = { diskPct: [50, 99], uptimeDays: [1, 365], pollSec: [10, 600] };
export const DISK_GAP = 2;

const DAY = 86400;

// The saved settings as whole numbers inside RANGES; anything missing or off falls back to DEFAULTS.
export function limitsOf(saved) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const raw = saved?.[k];
    const n = raw == null || raw === "" ? NaN : Math.round(Number(raw)); // Number(null) is 0, not "missing"
    const [lo, hi] = RANGES[k];
    out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[k];
  }
  return out;
}

// `state` is what was already notified for this machine ({ disk, uptime }, or null); returns the new
// state and the notifications to post now.
export function step(name, stats, state, limits = DEFAULTS) {
  const next = { disk: Boolean(state?.disk), uptime: Boolean(state?.uptime) };
  const alerts = [];

  if (stats.diskPct >= limits.diskPct && !next.disk) {
    next.disk = true;
    alerts.push({
      title: `${name} 磁碟用量 ${stats.diskPct}%`,
      body: `剩 ${stats.diskFreeGb.toFixed(1)}G / ${stats.diskTotalGb.toFixed(0)}G，該清理了`,
    });
  } else if (stats.diskPct < limits.diskPct - DISK_GAP) {
    next.disk = false;
  }

  if (stats.upSec >= limits.uptimeDays * DAY && !next.uptime) {
    next.uptime = true;
    alerts.push({
      title: `${name} 已連續運作 ${Math.floor(stats.upSec / DAY)} 天`,
      body: `超過 ${limits.uptimeDays} 天沒重開機，找時間重開`,
    });
  } else if (stats.upSec < limits.uptimeDays * DAY) {
    next.uptime = false;
  }

  return { alerts, state: next };
}
