// Pure helpers for the PR panel: `gh` JSON summaries and unified-diff parsing.

const FAIL = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

// statusCheckRollup mixes CheckRun {status, conclusion} and StatusContext {state}.
export function checksState(rollup) {
  if (!rollup || !rollup.length) return "none";
  let pending = false;
  for (const c of rollup) {
    const verdict = String(c.conclusion || c.state || "").toUpperCase();
    const status = String(c.status || "").toUpperCase();
    if (FAIL.includes(verdict)) return "fail";
    if ((status && status !== "COMPLETED") || verdict === "PENDING" || verdict === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}

// Why Merge is unavailable, or null when it may be offered.
export function mergeBlocker(pr, checks) {
  if (pr.state !== "OPEN") return "Not open";
  if (pr.isDraft) return "Draft";
  if (pr.mergeable === "CONFLICTING") return "Has conflicts";
  if (checks === "fail") return "Checks failing";
  if (checks === "pending") return "Checks pending";
  return null;
}

// `gh pr diff` output -> [{path, add, del, binary, rows}] with rows {kind, number, text}.
// kind: "@" hunk header, "+" added, "-" removed, " " context.
export function parseDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const head = /^a\/(.*) b\/(.*)$/.exec(lines[0]);
    let path = head ? head[2] : lines[0];
    const file = { path, add: 0, del: 0, binary: false, rows: [] };
    let old = 0, next = 0, inHunk = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!inHunk) {
        if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) file.binary = true;
        if (line.startsWith("+++ b/")) file.path = line.slice(6);
        else if (line.startsWith("--- a/") && lines[i + 1] === "+++ /dev/null") file.path = line.slice(6);
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { inHunk = true; old = Number(m[1]); next = Number(m[2]); file.rows.push({ kind: "@", text: line }); continue; }
      if (!inHunk) continue;
      if (line.startsWith("+")) { file.add++; file.rows.push({ kind: "+", number: next++, text: line.slice(1) }); }
      else if (line.startsWith("-")) { file.del++; file.rows.push({ kind: "-", number: old++, text: line.slice(1) }); }
      else if (line.startsWith("\\")) file.rows.push({ kind: "@", text: line });
      else if (i < lines.length - 1 || line !== "") { file.rows.push({ kind: " ", number: next++, text: line.slice(1) }); old++; }
    }
    files.push(file);
  }
  return files;
}

export function relativeTime(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}
