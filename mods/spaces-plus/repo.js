// spaces-plus: what we know about a git checkout. Pure: no Herdr imports, so `bun test` runs it.

export const base = (path) => path.replace(/\/+$/, "").split("/").pop();

/** The repo's name from its git-common-dir: `/code/r/.git` -> `r`, `/store/r.git` -> `r`. */
export function repoName(common) {
  return common.endsWith("/.git") ? base(common.slice(0, -5)) : base(common).replace(/\.git$/, "");
}

/**
 * @param {{ on: string | null, top: string, common: string, gitDir: string }} paths
 *   `git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`, and the machine.
 * A linked worktree has its own git dir apart from the shared one. A repo whose .git lives elsewhere
 * (`--separate-git-dir`) does not, so it is not linked even though `common` is not `<top>/.git`.
 */
export function repoInfo({ on, top, common, gitDir }) {
  return {
    name: repoName(common),
    top,
    branch: null,
    ahead: 0,
    behind: 0,
    repo: JSON.stringify([on, common]),
    linked: gitDir !== common,
  };
}

/** `branch`, `ahead`, `behind` from `git status --porcelain=v2 --branch`. */
export function parseBranch(porcelain) {
  const out = { branch: null, ahead: 0, behind: 0 };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) out.branch = line.slice(14);
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).split(" ");
      out.ahead = Math.abs(parseInt(a, 10)) || 0;
      out.behind = Math.abs(parseInt(b, 10)) || 0;
    }
  }
  return out;
}

/** The main checkout of a repo key `[machine, "<top>/.git"]`; null when it has no `.git` under a checkout. */
export function mainTop(repoKey) {
  try {
    const dir = JSON.parse(repoKey)[1];
    return typeof dir === "string" && dir.endsWith("/.git") ? dir.slice(0, -5) : null;
  } catch {
    return null;
  }
}
