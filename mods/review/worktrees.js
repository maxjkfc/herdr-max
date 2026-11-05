// The pure parts of working with several worktrees: reading `git worktree list --porcelain`, counting
// `git status` entries, naming a worktree. No Herdr imports, so tests/review-worktrees.test.js can run it.

// [{ path, branch, head, detached }] for the usable worktrees (bare and prunable ones are left out).
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9), branch: null, head: null, detached: false, bare: false, prunable: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  return out.filter((w) => !w.bare && !w.prunable);
}

// Entries in `git status --porcelain=v1 -z --no-renames`: one NUL-terminated record per path.
export const dirtyCount = (text) => String(text).split("\0").filter(Boolean).length;

export const nameOf = (path) => String(path).split("/").filter(Boolean).pop() ?? String(path);
