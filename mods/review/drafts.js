// The pure parts of review comments: drafts anchored to diff rows, the message sent to an agent, and which agent is
// the right one. No Herdr imports, so tests/review-drafts.test.js can run it.

const MAX_QUOTE = 12;

export const rowDesc = (r) => ({ kind: r.kind, number: r.number ?? null, text: r.text });
const descKey = (d) => `${d.kind}|${d.number}|${d.text}`;
const lineKey = (d) => `${d.kind}|${d.text}`;

// Index of the row that is `d`, nearest to `hint`. A line is its kind, number and text, so a comment finds its line
// again after a reload; when only the number moved (lines added above) it falls back to kind and text if that is
// unambiguous. -1 when the line is gone.
export function findRow(rows, d, hint = 0) {
  const nearest = (match) => {
    let best = -1;
    for (let i = 0; i < rows.length; i++) if (match(rowDesc(rows[i])) && (best < 0 || Math.abs(i - hint) < Math.abs(best - hint))) best = i;
    return best;
  };
  const exact = nearest((x) => descKey(x) === descKey(d));
  if (exact >= 0) return exact;
  const loose = rows.map(rowDesc).filter((x) => lineKey(x) === lineKey(d));
  return loose.length === 1 ? nearest((x) => lineKey(x) === lineKey(d)) : -1;
}

// { from, to } rows of a draft in `rows`, or null when its lines are gone (a stale draft).
export function locate(rows, draft) {
  const from = findRow(rows, draft.first, 0);
  if (from < 0) return null;
  const to = findRow(rows, draft.last, from);
  return to >= from ? { from, to } : null;
}

// A draft for rows[from..to] (hunk headers skipped); null when no line is left. `quote` keeps the lines for the message.
export function makeDraft({ id, path, rows, from, to, body }) {
  const lines = rows.slice(from, to + 1).filter((r) => r.kind !== "@").map(rowDesc);
  if (!lines.length || !body.trim()) return null;
  return { id, path, body: body.trim(), first: lines[0], last: lines[lines.length - 1], quote: lines.slice(0, MAX_QUOTE), cut: Math.max(0, lines.length - MAX_QUOTE) };
}

// "12–15", "12", or "old 11–13" for removed lines only.
export function lineLabel(draft) {
  const removedOnly = draft.quote.every((l) => l.kind === "-");
  const nums = draft.quote.filter((l) => removedOnly || l.kind !== "-").map((l) => l.number).filter((n) => n != null);
  if (!nums.length) return "";
  const a = Math.min(...nums), b = Math.max(...nums);
  return `${removedOnly ? "old " : ""}${a === b ? a : `${a}–${b}`}`;
}

const sortKey = (d) => [d.path, d.first.number ?? 0];

// The one message an agent gets for a set of drafts: where, which lines (quoted), what to change.
export function reviewMessage({ root, on, scopeWords, drafts }) {
  const sorted = [...drafts].sort((a, b) => { const [pa, la] = sortKey(a), [pb, lb] = sortKey(b); return pa === pb ? la - lb : pa.localeCompare(pb); });
  const out = [
    `Code review of ${root}${on ? ` (on ${on})` : ""}: ${scopeWords}.`,
    `${sorted.length} comment${sorted.length === 1 ? "" : "s"}. Line numbers are new-file numbers; "old" marks removed lines (old-file numbers). Quoted lines start with + (added), - (removed) or a space (context).`,
  ];
  for (const d of sorted) {
    out.push("", `### ${d.path}, lines ${lineLabel(d)}`, "```diff", ...d.quote.map((l) => `${l.kind === "+" || l.kind === "-" ? l.kind : " "}${l.text}`));
    if (d.cut) out.push(`… ${d.cut} more line${d.cut === 1 ? "" : "s"}`);
    out.push("```", d.body);
  }
  return out.join("\n");
}

// The message for a question about some lines (no draft): the lines, quoted.
export function askMessage({ root, on, path, rows }) {
  const lines = rows.filter((r) => r.kind !== "@").map(rowDesc);
  const quote = lines.slice(0, MAX_QUOTE), cut = lines.length - quote.length;
  const d = { quote };
  return [
    `About ${path}, lines ${lineLabel(d)}, in ${root}${on ? ` (on ${on})` : ""}:`,
    "```diff", ...quote.map((l) => `${l.kind === "+" || l.kind === "-" ? l.kind : " "}${l.text}`),
    ...(cut > 0 ? [`… ${cut} more line${cut === 1 ? "" : "s"}`] : []), "```",
  ].join("\n");
}

const inside = (path, root) => Boolean(path) && (path === root || path.startsWith(`${root}/`));

// The agents that could take a review of `root`, best first. Score 3: its terminal is in the repo (or the worktree);
// 2: its space's folder is; 1: it is in a folder above (a worktree under it); 0: any other. On a remote machine
// (`on`) only that machine's agents, otherwise only this computer's.
export function matchAgents({ agents, panes, spaces, root, on }) {
  const mine = agents.filter((a) => (on ? a.address.startsWith(`${on}/`) : !a.address.includes("/")));
  return mine.map((a) => {
    const cwd = panes.find((p) => p.pane === a.pane)?.cwd ?? null, space = spaces.find((s) => s.id === a.space)?.folder ?? null;
    const score = inside(cwd, root) ? 3 : inside(space, root) ? 2 : (cwd && root.startsWith(`${cwd}/`)) || (space && root.startsWith(`${space}/`)) ? 1 : 0;
    return { agent: a, cwd, score };
  }).sort((x, y) => y.score - x.score || Number(y.agent.focused) - Number(x.agent.focused) || y.agent.seq - x.agent.seq);
}
