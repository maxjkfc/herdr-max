import { trimLog } from "./log.js";
import { exec, home, shared, spaces } from "herdr";
import { describeRemote, githubSlug } from "./platform.js";

// The gh account the panel acts as: `shared("git-remote.user")`, set by the panel for the focused folder
// (shared state so the PR dialog, a separate view, follows it). Null = gh's own active account. The token is
// read inside the shell and put in GH_TOKEN there, never in an argument list; an account gh doesn't know fails
// loudly instead of quietly falling back to the active one. Not applied on another machine (`on`): its gh is its own.
const AS_USER = 'T=$(gh auth token --user "$0") || { echo "gh has no logged-in account $0" >&2; exit 3; }; GH_TOKEN=$T exec gh "$@"';
const runGh = (args, opts = {}) => {
  const user = opts.on ? null : shared("git-remote.user");
  return user ? exec("sh", ["-c", AS_USER, user, ...args], opts) : exec("gh", args, opts);
};

// Every GitHub call goes through gh: its auth, its host, its pagination.
export async function gh(args, opts = {}) {
  const r = await runGh(args, opts).catch((e) => ({ code: 127, stdout: "", stderr: String(e?.message ?? e) }));
  if (r.code !== 0) {
    const err = new Error((r.stderr || r.stdout || "gh failed").trim().split("\n").slice(-3).join(" ").slice(0, 300));
    err.code = r.code;
    throw err;
  }
  return r.stdout;
}
export const ghJson = async (args, opts) => JSON.parse(await gh(args, opts) || "null");

// What stops the panel before any repository: gh missing, signed out, or fine.
export async function account() {
  const r = await runGh(["api", "user", "--jq", ".login"]).catch(() => null);
  if (!r) return { state: "missing" };
  if (r.code !== 0) return { state: /401|auth|log ?in|token/i.test(r.stderr) ? "logged_out" : "error", detail: r.stderr.trim() };
  const orgs = await gh(["api", "user/orgs", "--jq", ".[].login"]).catch(() => "");
  return { state: "ready", login: r.stdout.trim(), orgs: orgs.split("\n").map((s) => s.trim()).filter(Boolean) };
}

// The accounts gh is logged in to on github.com: [{ login, active }].
export async function loginsOf() {
  const r = await exec("gh", ["auth", "status", "--json", "hosts", "--jq", '.hosts["github.com"] // [] | map({login, active})']).catch(() => null);
  try { return r?.code === 0 ? JSON.parse(r.stdout) : []; } catch { return []; }
}

// The account a folder declares for itself: the nearest .envrc (this folder or above) that sets GH_TOKEN from
// `gh auth token --user <name>`, the convention direnv users already have. Null when none does.
export async function declaredUser(folder) {
  const script = 'd=$1; while [ -n "$d" ] && [ "$d" != / ]; do f="$d/.envrc"; if [ -f "$f" ]; then u=$(sed -n \'s/.*gh auth token --user[ =]\\([A-Za-z0-9-]*\\).*/\\1/p\' "$f" | head -1); [ -n "$u" ] && { echo "$u"; exit 0; }; fi; d=$(dirname "$d"); done';
  const r = await exec("sh", ["-c", script, "sh", folder]).catch(() => null);
  return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// The `owner/repo` of a GitHub remote URL; null for any other platform.
export const slugOf = (remote) => githubSlug(describeRemote(remote));

// The platform and path of a folder's origin remote (no network): see platform.js.
export async function remoteOf(cwd, on) {
  const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on }).catch(() => null);
  return r?.code === 0 ? describeRemote(r.stdout) : null;
}

// Local clones by repo: the usual project folders under home, plus the layout's own (`props.roots`),
// then the spaces' folders, which win.
export const ROOTS = ["projets", "projects", "Projects", "code", "Code", "src", "dev", "Developer", "work", "git", "github", "Documents/GitHub", ".herdr/worktrees"];
export async function checkouts(extra = []) {
  const script = `for root in "$@"; do [ -d "$root" ] || continue
  find "$root" -maxdepth 3 -type d -name .git -prune 2>/dev/null | while IFS= read -r g; do d=$(dirname "$g")
    u=$(git -C "$d" remote get-url origin 2>/dev/null) && printf '%s\\t%s\\n' "$u" "$d"; done; done`;
  const r = await exec("bash", ["-c", script, "scan", ...[...ROOTS, ...extra].map((d) => d.startsWith("/") ? d : `${home()}/${d}`)]).catch(() => null);
  const map = {};
  for (const line of (r?.stdout ?? "").split("\n")) {
    const [url, dir] = line.split("\t"), slug = url && slugOf(url);
    if (slug && dir && !map[slug]) map[slug] = { folder: dir };
  }
  const list = [...spaces()].sort((a, b) => Number((a.folder ?? "").includes("/.herdr/worktrees/")) - Number((b.folder ?? "").includes("/.herdr/worktrees/")));
  for (const s of list) {
    if (!s.folder || s.machine) continue;
    const slug = githubSlug(await remoteOf(s.folder, null));
    if (slug && (!map[slug]?.space || !(s.folder ?? "").includes("/.herdr/worktrees/"))) map[slug] = { folder: s.folder, space: s.id };
  }
  return map;
}

const ISSUE = "number,title,body,url,state,stateReason,labels,assignees,author,createdAt,updatedAt,comments,milestone";
const SEARCH_ISSUE = "number,title,url,state,labels,assignees,author,createdAt,updatedAt,commentsCount,repository";
const PR = "number,title,url,state,isDraft,labels,assignees,author,createdAt,updatedAt,headRefName,baseRefName,headRefOid,mergeable,changedFiles,reviewDecision,statusCheckRollup,comments,additions,deletions,mergedAt";
const SEARCH_PR = "number,title,url,state,isDraft,labels,author,createdAt,updatedAt,commentsCount,repository";
const RUN = "databaseId,number,displayTitle,status,conclusion,workflowName,headBranch,headSha,event,createdAt,updatedAt,startedAt,url,attempt";

const repoName = (i) => i.repository?.nameWithOwner ?? i.repository?.fullName ?? null;
const norm = (list, repo) => list.map((i) => ({ ...i, repo: repo ?? repoName(i), comments: i.comments?.length ?? i.commentsCount ?? 0 }));

// One loader per tab. `scope` is { repo } or { owners: [...] }, `q` the filters.
export const load = {
  async issues({ repo, owners }, { state, mine, milestone }) {
    if (repo) {
      const args = ["issue", "list", "-R", repo, "--state", state, "--limit", "200", "--json", ISSUE];
      if (mine) args.push("--assignee", "@me");
      if (milestone) args.push("--milestone", milestone);
      return norm(await ghJson(args), repo);
    }
    const args = ["search", "issues", ...owners.flatMap((o) => ["--owner", o]), "--state", state, "--sort", "updated", "--limit", "200", "--json", SEARCH_ISSUE];
    if (mine) args.push("--assignee", "@me");
    return norm(await ghJson(args));
  },
  async prs({ repo, owners }, { state, mine }) {
    if (repo) {
      const args = ["pr", "list", "-R", repo, "--state", state, "--limit", "100", "--json", PR];
      if (mine) args.push("--author", "@me");
      return norm(await ghJson(args), repo);
    }
    const args = ["search", "prs", ...owners.flatMap((o) => ["--owner", o]), "--state", state === "merged" ? "closed" : state, "--sort", "updated", "--limit", "100", "--json", SEARCH_PR];
    if (state === "merged") args.push("--merged");
    if (mine) args.push("--author", "@me");
    return norm(await ghJson(args));
  },
  async actions({ repo }, { branch, failing }) {
    const args = ["run", "list", "-R", repo, "--limit", "50", "--json", RUN];
    if (branch) args.push("--branch", branch);
    if (failing) args.push("--status", "failure");
    return (await ghJson(args)).map((r) => ({ ...r, repo }));
  },
  async milestones({ repo }, { state }) {
    const list = await ghJson(["api", `repos/${repo}/milestones?state=${state}&sort=due_on&per_page=100`]);
    return list.map((m) => ({ number: m.number, title: m.title, description: m.description, state: m.state, open: m.open_issues, closed: m.closed_issues, due: m.due_on, url: m.html_url, updatedAt: m.updated_at, repo }));
  },
  async projects({ repo, owners }) {
    const all = [];
    for (const owner of owners ?? [repo.split("/")[0]]) {
      const r = await ghJson(["project", "list", "--owner", owner, "--format", "json", "--limit", "50"]);
      for (const p of r.projects ?? []) all.push({ ...p, owner, items: p.items?.totalCount ?? 0 });
    }
    return all.filter((p) => !p.closed);
  },
  async repos({ owners }) {
    const all = [];
    for (const owner of owners) {
      const list = await ghJson(["repo", "list", owner, "--limit", "100", "--no-archived", "--json", "nameWithOwner,description,pushedAt,isPrivate,isFork,primaryLanguage,stargazerCount,url"]);
      all.push(...list);
    }
    return all.sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
  },
  async repo({ repo }) {
    const info = await ghJson(["repo", "view", repo, "--json", "nameWithOwner,description,defaultBranchRef,stargazerCount,forkCount,watchers,primaryLanguage,latestRelease,homepageUrl,repositoryTopics,pushedAt,visibility,isArchived,url,sshUrl,licenseInfo,issues,pullRequests"]);
    const [branches, releases] = await Promise.all([
      ghJson(["api", `repos/${repo}/branches?per_page=100`, "--jq", "[.[].name]"]).catch(() => []),
      ghJson(["release", "list", "-R", repo, "--limit", "5", "--json", "name,tagName,publishedAt,isLatest,isPrerelease"]).catch(() => []),
    ]);
    return { ...info, branches, releases };
  },
};

// The checkout's own state: branch, changes, ahead/behind its upstream.
export async function localState(folder) {
  const r = await exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: folder }).catch(() => null);
  if (r?.code !== 0) return null;
  const out = { branch: null, ahead: 0, behind: 0, changed: 0 };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) out.branch = line.slice(14);
    else if (line.startsWith("# branch.ab ")) { const [a, b] = line.slice(12).split(" "); out.ahead = +a; out.behind = -b; }
    else if (line && !line.startsWith("#")) out.changed++;
  }
  // Every worktree of the clone with its branch: the agent for a PR works in the one that has the PR's branch.
  const w = await exec("git", ["worktree", "list", "--porcelain"], { cwd: folder }).catch(() => null);
  out.worktrees = [];
  for (const line of w?.code === 0 ? w.stdout.split("\n") : []) {
    if (line.startsWith("worktree ")) out.worktrees.push({ path: line.slice(9), branch: null });
    else if (line.startsWith("branch ") && out.worktrees.length) out.worktrees[out.worktrees.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return out;
}

// A failed run's log, trimmed for an agent (log.js).
export async function failedLog(repo, id) {
  return trimLog(await gh(["run", "view", String(id), "-R", repo, "--log-failed"]).catch(() => ""));
}
