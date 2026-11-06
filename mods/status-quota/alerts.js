// Low-quota alerts and a burn-rate estimate for the quota windows. Pure: main.js owns
// the state (persisted in localStorage) and posts the notifications.
//
// state = { notified: { [key]: { level, resetsAt } }, hist: { [key]: { resetsAt, samples: [[at, used]] } } }

export const LOW = 20; // remaining % at or below which a window is "low"
export const CRITICAL = 5; // ... and "critical"

const SAME_WINDOW_MS = 10 * 60_000; // resetsAt drifts by seconds between fetches
const HIST_MS = 90 * 60_000; // samples older than this don't count towards the rate
const MIN_SPAN_MS = 10 * 60_000; // need at least this long a span to trust a rate
const MAX_SAMPLES = 60;

export const itemKey = (p, it) => `${p.id}|${it.label}`;

export const levelOf = (remaining) => (remaining <= CRITICAL ? 2 : remaining <= LOW ? 1 : 0);

const sameWindow = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < SAME_WINDOW_MS;

export function fmtDuration(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Usage rate over the recent samples; the window is only worth a warning if it runs out before it resets.
function estimate(samples, item, now) {
  const recent = samples.filter(([at]) => now - at <= HIST_MS);
  if (recent.length < 2) return null;
  const [at0, used0] = recent[0];
  const [at1, used1] = recent[recent.length - 1];
  if (at1 - at0 < MIN_SPAN_MS || used1 <= used0) return null;
  const perMs = (used1 - used0) / (at1 - at0);
  const ms = item.remaining / perMs;
  if (!item.resetsAt || now + ms >= item.resetsAt) return null;
  return { ms };
}

export function step(providers, state, now) {
  const next = { notified: {}, hist: {} };
  const alerts = [];
  const eta = {};
  for (const p of providers ?? []) {
    for (const it of p.items ?? []) {
      if (typeof it.remaining !== "number") continue;
      const key = itemKey(p, it);

      const prev = state?.notified?.[key];
      const known = prev && sameWindow(prev.resetsAt, it.resetsAt) ? prev.level : 0;
      const level = levelOf(it.remaining);
      if (level > known) alerts.push({ key, provider: p, item: it, level });
      next.notified[key] = { level: Math.max(level, known), resetsAt: it.resetsAt };

      const h = state?.hist?.[key];
      const samples = h && sameWindow(h.resetsAt, it.resetsAt) ? h.samples : [];
      const kept = [...samples, [now, it.used]].filter(([at]) => now - at <= HIST_MS).slice(-MAX_SAMPLES);
      next.hist[key] = { resetsAt: it.resetsAt, samples: kept };
      const e = estimate(kept, it, now);
      if (e) eta[key] = e;
    }
  }
  return { state: next, alerts, eta };
}

// One notification per refresh, however many windows crossed a threshold.
export function alertMessage(alerts, name) {
  const worst = Math.max(...alerts.map((a) => a.level));
  return {
    title: worst === 2 ? "額度即將用盡" : "額度偏低",
    level: worst === 2 ? "error" : "warning",
    // The toast shows one truncated line, so keep each window to a few words.
    body: alerts.map((a) => `${name(a.provider)} ${a.item.label} ${a.item.remaining}%`).join(" · "),
  };
}
