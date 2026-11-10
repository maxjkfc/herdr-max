const URGENT = { blocked: 2, done: 1 };

/**
 * The agent a person should look at next: blocked before done, the most recent first (`seq` grows with
 * recency). Idle and working agents are never urgent: Herdr turns `done` into `idle` once it is seen.
 */
export function mostUrgent(list) {
  let best = null;
  for (const a of list ?? []) {
    const r = URGENT[a.status];
    if (!r) continue;
    if (!best || r > URGENT[best.status] || (r === URGENT[best.status] && (a.seq ?? 0) > (best.seq ?? 0))) best = a;
  }
  return best;
}
