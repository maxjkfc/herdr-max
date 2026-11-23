// When a watched machine deserves a notification. Pure: no herdr imports, so tests can load it.
//
// Each condition notifies once when it starts to hold and again only after it has cleared:
//   disk   : used % reaches DISK_PCT; re-arms once it is back under DISK_CLEAR (a gap, so a volume
//            hovering around the line doesn't notify on every poll)
//   uptime : up for UPTIME_DAYS or more; re-arms on the next reboot

export const DISK_PCT = 92;
export const DISK_CLEAR = 90;
export const UPTIME_DAYS = 28;

const DAY = 86400;

// `state` is what was already notified for this machine ({ disk, uptime }, or null); returns the new
// state and the notifications to post now.
export function step(name, stats, state) {
  const next = { disk: Boolean(state?.disk), uptime: Boolean(state?.uptime) };
  const alerts = [];

  if (stats.diskPct >= DISK_PCT && !next.disk) {
    next.disk = true;
    alerts.push({
      title: `${name} 磁碟用量 ${stats.diskPct}%`,
      body: `剩 ${stats.diskFreeGb.toFixed(1)}G / ${stats.diskTotalGb.toFixed(0)}G，該清理了`,
    });
  } else if (stats.diskPct < DISK_CLEAR) {
    next.disk = false;
  }

  if (stats.upSec >= UPTIME_DAYS * DAY && !next.uptime) {
    next.uptime = true;
    alerts.push({
      title: `${name} 已連續運作 ${Math.floor(stats.upSec / DAY)} 天`,
      body: `超過 ${UPTIME_DAYS} 天沒重開機，找時間重開`,
    });
  } else if (stats.upSec < UPTIME_DAYS * DAY) {
    next.uptime = false;
  }

  return { alerts, state: next };
}
