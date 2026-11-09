// spaces-plus: which Space a linked worktree sits under. Pure: no Herdr imports, so `bun test` runs it.
//
// A row is `{ w, i, cwd, g }`: the Space, its index, the folder it is in and what git said about it (`repoInfo`).

import { mainTop } from "./repo.js";

const trim = (path) => (path ?? "").replace(/\/+$/, "");
const onSame = (a, b) => (a.w.machine ?? null) === (b.w.machine ?? null);

/** A worktree is a linked git worktree, or any folder under `~/.herdr/worktrees/`. */
export const isWorktree = (row) => Boolean(row.g?.linked || (row.w.folder ?? "").includes("/.herdr/worktrees/"));

/**
 * The main Space a worktree row belongs under, or null. In order:
 * 1. the Space it was opened from (`meta[path].parentSpaceId`, written by worktree-plus);
 * 2. the main Space on the same repo;
 * 3. a main Space named like the repo;
 * 4. a main Space whose folder holds the repo (an umbrella folder), never `home` itself.
 * Only Spaces on the worktree's own machine count.
 */
export function parentOf(k, mains, { meta = {}, home = "" } = {}) {
  const here = mains.filter((m) => onSame(m, k));
  const hit = meta[trim(k.cwd || k.w.folder)] ?? meta[trim(k.g?.top)];
  const opened = hit?.parentSpaceId && here.find((m) => m.w.id === hit.parentSpaceId);
  if (opened) return opened;
  if (k.g?.repo) {
    const sameRepo = here.find((m) => m.g?.repo === k.g.repo);
    if (sameRepo) return sameRepo;
  }
  if (k.g?.name) {
    const named = here.find((m) => m.w.name.toLowerCase() === k.g.name.toLowerCase());
    if (named) return named;
  }
  const repoDir = mainTop(k.g?.repo);
  if (repoDir) {
    const umbrella = here.find((m) => {
      const folder = trim(m.w.folder || m.cwd);
      return folder && folder !== trim(home) && repoDir.startsWith(`${folder}/`);
    });
    if (umbrella) return umbrella;
  }
  return null;
}

const branchOf = (rows) => rows.map((r, n) => ({ ...r, tree: n === rows.length - 1 ? "└─" : "├─" }));

/** Stand-in for a repo whose main checkout is not open: its worktrees sit under it. Clicking it opens the repo. */
function ghostFor(first) {
  const top = mainTop(first.g.repo);
  return {
    ghost: true,
    tree: null,
    i: first.i,
    w: { id: `ghost:${first.g.repo}`, name: first.g.name, folder: top, machine: first.w.machine ?? null, status: null, tabs: [] },
    g: { ...first.g, linked: false, branch: null, ahead: 0, behind: 0, top },
    cwd: top,
  };
}

/**
 * Rows in display order: each main Space followed by its worktrees; then worktrees whose main Space is not
 * open, two or more of one repo under a ghost row, the rest alone. Each row gets `tree` (`├─`, `└─` or null)
 * and `isWt`.
 */
export function nest(rows, options = {}) {
  const tagged = rows.map((r) => ({ ...r, isWt: isWorktree(r) }));
  const mains = tagged.filter((r) => !r.isWt);
  const under = new Map(mains.map((m) => [m.w.id, []]));
  const orphans = [];
  for (const r of tagged) {
    if (!r.isWt) continue;
    const parent = parentOf(r, mains, options);
    (parent ? under.get(parent.w.id) : orphans).push(r);
  }

  const out = mains.flatMap((m) => [{ ...m, tree: null }, ...branchOf(under.get(m.w.id))]);
  // A repo key already names its machine, so rows with the same key are on the same machine.
  const family = (r) => (r.g?.repo ? orphans.filter((o) => o.g?.repo === r.g.repo) : [r]);
  const placed = new Set();
  for (const r of orphans) {
    if (placed.has(r)) continue;
    const same = family(r);
    same.forEach((o) => placed.add(o));
    if (same.length > 1) out.push(ghostFor(same[0]), ...branchOf(same));
    else out.push({ ...r, tree: "└─" });
  }
  return out;
}

/** What a pin remembers a Space by: its machine and folder, which exist before git has answered. */
export const pinKey = (w) => JSON.stringify([w.machine ?? null, w.folder ?? w.id]);

/** Pinned Spaces first, each with its worktrees; every other order is kept. `pinned` is a Set of `pinKey`s. */
export function pinFirst(rows, pinned) {
  const blocks = [];
  for (const r of rows) {
    if (r.tree && blocks.length) blocks[blocks.length - 1].push(r);
    else blocks.push([r]);
  }
  const isPinned = (block) => !block[0].ghost && pinned.has(pinKey(block[0].w));
  return [...blocks.filter(isPinned), ...blocks.filter((b) => !isPinned(b))].flat();
}
