import { exec } from "herdr";

// A new worktree only has what git tracks, so project skills that are untracked or gitignored in the main checkout
// (`.agents/skills`, `.claude/skills`, …) are missing there. Link each one to the main checkout's folder, unless the
// worktree already has that path, and add it to the repo's info/exclude so `git add -A` never commits the link.
const SKILL_DIRS = [".agents/skills", ".claude/skills", ".omp/skills", ".codex/skills"];
const SCRIPT = `main=$1; wt=$2; shift 2
ex=$(git -C "$wt" rev-parse --path-format=absolute --git-path info/exclude) || exit 0
for rel in "$@"; do
  src="$main/$rel"; dst="$wt/$rel"
  [ -d "$src" ] || continue
  [ -e "$dst" ] || [ -L "$dst" ] && continue
  mkdir -p "$(dirname "$dst")" && ln -s "$src" "$dst" || continue
  mkdir -p "$(dirname "$ex")"; grep -qxF "/$rel" "$ex" 2>/dev/null || printf '/%s\\n' "$rel" >> "$ex"
  echo "$rel"
done`;

// The skill folders linked into `worktree`; never throws, a failed link only means the skills are missing.
export async function linkProjectSkills(mainRepo, worktree, on = null) {
  const r = await exec("sh", ["-c", SCRIPT, "sh", mainRepo, worktree, ...SKILL_DIRS], { on }).catch(() => null);
  return r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}
