// Mirror of mods/git-remote/platform.js: a mod cannot import another mod's files. Change both together.
// Which git platform a remote URL belongs to, from its host alone (no network).
// `supported` is whether this mod can list that platform's PRs / issues / CI: only GitHub, through `gh`.

const PLATFORMS = [
  { id: "github", label: "GitHub", color: null, supported: true, test: (h) => h === "github.com" },
  { id: "gitlab", label: "GitLab", color: "#fc6d26", test: (h) => h === "gitlab.com" || h.startsWith("gitlab.") },
  { id: "bitbucket", label: "Bitbucket", color: "#2684ff", test: (h) => h === "bitbucket.org" || h.startsWith("bitbucket.") },
  { id: "codeberg", label: "Codeberg", color: "#2185d0", test: (h) => h === "codeberg.org" },
  { id: "gitea", label: "Gitea", color: "#609926", test: (h) => h.startsWith("gitea.") || h.startsWith("forgejo.") },
  { id: "azure", label: "Azure DevOps", color: "#0078d4", test: (h) => h === "dev.azure.com" || h === "ssh.dev.azure.com" || h.endsWith(".visualstudio.com") },
  { id: "sourcehut", label: "SourceHut", color: "#9ca3af", test: (h) => h === "git.sr.ht" },
  { id: "codecommit", label: "AWS CodeCommit", color: "#ff9900", test: (h) => /^git-codecommit\..+\.amazonaws\.com(\.cn)?$/.test(h) },
  { id: "ghe", label: "GitHub Enterprise", color: null, test: (h) => h.startsWith("github.") },
];

// `https://host/a/b.git`, `ssh://git@host:22/a/b.git` and `git@host:a/b.git` → { host, path }.
export function parseRemote(remote) {
  const s = String(remote ?? "").trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s) ?? /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
  if (!m) return null;
  const path = m[2].replace(/\/+$/, "").replace(/\.git$/, "");
  return path ? { host: m[1].toLowerCase(), path } : null;
}

// { id, label, color, supported, host, slug } for a remote URL; an unlisted host is `{ id: "git", label: host }`.
export function describeRemote(remote) {
  const p = parseRemote(remote);
  if (!p) return null;
  const hit = PLATFORMS.find((x) => x.test(p.host));
  return { id: hit?.id ?? "git", label: hit?.label ?? p.host, color: hit?.color ?? null, supported: Boolean(hit?.supported), host: p.host, slug: p.path };
}

// The `owner/repo` of a GitHub remote, else null.
export function githubSlug(d) {
  return d?.id === "github" && /^[^/]+\/[^/]+$/.test(d.slug) ? d.slug : null;
}
