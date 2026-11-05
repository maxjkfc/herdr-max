// GitHub's REST timeline (`repos/:repo/issues/:n/timeline`, shared by issues and pull requests),
// reduced to what the viewer draws: cards (comments, reviews) and one-line events.

const EMOJI = { THUMBS_UP: "👍", "+1": "👍", THUMBS_DOWN: "👎", "-1": "👎", LAUGH: "😄", laugh: "😄", HOORAY: "🎉", hooray: "🎉", CONFUSED: "😕", confused: "😕", HEART: "❤️", heart: "❤️", ROCKET: "🚀", rocket: "🚀", EYES: "👀", eyes: "👀" };

export const loginOf = (user) => user?.login ?? "ghost";

// Reactions as "👍 3", from GraphQL reactionGroups or a REST reactions object.
export function tally(groups) {
  const pairs = Array.isArray(groups) ? groups.map((g) => [g.content, g.users?.totalCount ?? 0]) : Object.entries(groups ?? {});
  return pairs.filter(([kind, n]) => EMOJI[kind] && n > 0).map(([kind, n]) => `${EMOJI[kind]} ${n}`);
}

const commitOf = (sha, url, message) => ({ sha: String(sha ?? "").slice(0, 7), url, message: message?.split("\n")[0] ?? null });

// One builder per event GitHub sends; events left out (subscribed, project cards…) aren't drawn.
const BUILD = {
  commented: (e) => ({ card: "comment", body: e.body, role: e.author_association, reactions: tally(e.reactions) }),
  reviewed: (e) => e.state === "commented" && !e.body?.trim() ? null : { card: "review", review: String(e.state).toUpperCase(), body: e.body, role: e.author_association },
  labeled: (e) => ({ labels: { added: [e.label], removed: [] } }),
  unlabeled: (e) => ({ labels: { added: [], removed: [e.label] } }),
  assigned: (e) => ({ assigned: loginOf(e.assignee) }),
  unassigned: (e) => ({ unassigned: loginOf(e.assignee) }),
  closed: (e) => ({ closed: e.state_reason ?? "completed" }),
  reopened: () => ({ reopened: true }),
  merged: (e) => ({ merged: commitOf(e.commit_id) }),
  renamed: (e) => ({ renamed: { from: e.rename?.from ?? "", to: e.rename?.to ?? "" } }),
  milestoned: (e) => ({ milestone: { title: e.milestone?.title ?? "", added: true } }),
  demilestoned: (e) => ({ milestone: { title: e.milestone?.title ?? "", added: false } }),
  committed: (e) => ({ commit: commitOf(e.sha, e.html_url, e.message), who: e.author?.name ?? "commit", at: e.author?.date, avatar: null }),
  referenced: (e) => {
    const repo = /repos\/([^/]+\/[^/]+)\/commits/.exec(e.commit_url ?? "")?.[1];
    return e.commit_id && repo ? { commit: commitOf(e.commit_id, `https://github.com/${repo}/commit/${e.commit_id}`) } : null;
  },
  "cross-referenced": (e) => {
    const s = e.source?.issue;
    return s ? { mention: { number: s.number, title: s.title, url: s.html_url, repo: s.repository?.full_name, pr: Boolean(s.pull_request), merged: Boolean(s.pull_request?.merged_at), open: s.state === "open" } } : null;
  },
};

// The entries in order. Label changes in a row by the same person read as one line.
export function entries(raw) {
  const out = [];
  for (const e of raw ?? []) {
    const built = BUILD[e.event]?.(e);
    if (!built) continue;
    const actor = e.actor ?? e.user;
    const entry = { who: loginOf(actor), avatar: actor?.avatar_url ?? null, at: e.created_at ?? e.submitted_at, ...built };
    const prev = out.at(-1);
    if (entry.closed && prev?.merged) continue; // a merge closes the pull request: GitHub shows the merge alone
    if (entry.labels && prev?.labels && prev.who === entry.who) {
      for (const side of ["added", "removed"]) for (const l of entry.labels[side]) {
        const other = side === "added" ? "removed" : "added", i = prev.labels[other].findIndex((x) => x.name === l.name);
        if (i >= 0) prev.labels[other].splice(i, 1); else prev.labels[side].push(l); // added then removed: nothing happened
      }
      continue;
    }
    out.push(entry);
  }
  return out.filter((x) => !x.labels || x.labels.added.length + x.labels.removed.length > 0);
}
