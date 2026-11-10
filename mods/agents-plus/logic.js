// Pure helpers for agents-plus.

/** How many agents sit in each state. */
export function counts(list) {
  const n = { blocked: 0, done: 0, working: 0, idle: 0 };
  for (const a of list ?? []) if (a.status in n) n[a.status]++;
  return n;
}
