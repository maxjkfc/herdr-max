// Reads an omp agent's session files on its own machine and shapes them for the panel.
// No mod-side file reads: session files pass readTextFile's 1 MiB cap, so jq sums them where they live.

// jq over raw lines: the file being appended may end in half a line, and one bad line must not drop the rest.
// Each file's state, keyed by path. Usage counts assistant replies and side calls (titles, auto-thinking).
export const JQ_PROG = String.raw`
def txt: if type == "string" then . elif type == "array" then (map(select(.type == "text") | .text) | join("\n")) else "" end;
def clip($n): if length > $n then .[:$n] + "…" else . end;
def use($u): if $u == null then . else
  .tok.input += ($u.input // 0) | .tok.output += ($u.output // 0)
  | .tok.cacheRead += ($u.cacheRead // 0) | .tok.cacheWrite += ($u.cacheWrite // 0)
  | .tok.total += ($u.totalTokens // 0) | .cost += ($u.cost.total // 0) end;
def step($e):
  if $e.type == "session" then .id = $e.id | .cwd = $e.cwd | .started = $e.timestamp
  elif $e.type == "title" or $e.type == "title_change" then (if ($e.title // "") != "" then .title = $e.title else . end)
  elif $e.type == "session_init" then .task = (($e.task // "") | clip(1500)) | .agent = $e.agent | .model = ($e.resolvedModel // .model)
  elif $e.type == "message" then
    $e.message as $m | .last = $e.timestamp
    | if $m.role == "assistant" then
        use($m.usage) | .replies += 1
        | .model = (($m.provider // "") + "/" + ($m.model // ""))
        | .ctx = (($m.usage.input // 0) + ($m.usage.cacheRead // 0) + ($m.usage.cacheWrite // 0) + ($m.usage.output // 0))
        | .error = (if $m.errorMessage then ($m.errorMessage | tostring | clip(300)) else null end)
        | (($m.content | txt) as $t | if $t != "" then .reply = ($t | clip(1500)) else . end)
      elif $m.role == "user" then .prompts += 1 | .prompt = (($m.content | txt) | clip(1500))
      else . end
  elif $e.type == "model_usage" then use($e.usage) | .aux += ($e.usage.cost.total // 0)
  elif $e.type == "compaction" then .compactions += 1
    | .compaction = {at: $e.timestamp, short: $e.shortSummary, summary: (($e.summary // "") | clip(4000)), before: $e.tokensBefore, after: $e.tokensAfter}
  elif $e.type == "custom" and $e.customType == "tool_execution_start" then
    ($e.data // {}) as $d | .doing = {tool: $d.toolName, intent: $d.intent, at: ($d.startedAt // $e.timestamp)}
  elif $e.type == "custom" and $e.customType == "session_exit" then .exit = ($e.data // {})
  else . end;
reduce (inputs | fromjson? | select(type == "object")) as $e ({}; .[input_filename] |= step($e))
| {main: $main, open: ($open | split("\n") | map(select(. != ""))), files: .}`;

// sh -c PROBE sh <pid> <finished paths, one per line> <JQ_PROG>
// The session files the process holds open (lsof -n -P: no DNS, fast) give its main session
// (the shallowest path) and its live sub-agents; finished sub-agents come from the session's folder.
// Already-summarized finished files are skipped: they never change again.
export const PROBE = String.raw`
pid=$1; skip=$2; prog=$3
JQ=$(command -v jq 2>/dev/null)
if [ -z "$JQ" ]; then for c in /opt/homebrew/bin/jq /usr/local/bin/jq /usr/bin/jq; do [ -x "$c" ] && JQ=$c && break; done; fi
[ -z "$JQ" ] && { echo '{"error":"nojq"}'; exit 0; }
open=$(lsof -n -P -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -E '/sessions/.+\.jsonl$')
[ -z "$open" ] && { echo '{"error":"nosession"}'; exit 0; }
main=$(printf '%s\n' "$open" | awk -F/ '{ print NF "\t" $0 }' | sort -n | head -n 1 | cut -f 2-)
subs=$(find "$(printf '%s' "$main" | sed 's/\.jsonl$//')" -type f -name '*.jsonl' 2>/dev/null | sort)
[ -n "$skip" ] && subs=$(printf '%s\n' "$subs" | grep -vxF -e "$skip")
printf '%s\n' "$main" "$subs" | grep -v '^$' | tr '\n' '\0' | xargs -0 "$JQ" -n -R -c --arg main "$main" --arg open "$open" "$prog"`;

// Raw probe output + finished sub-agents kept from earlier probes → what the panel shows.
// `finished`: the sub-agents that ended, to skip next time (pass back as `kept`).
export function shape(raw, kept = {}) {
  const files = { ...kept, ...raw.files };
  const main = { path: raw.main, ...files[raw.main] };
  const dir = raw.main.replace(/\.jsonl$/, "") + "/";
  const open = new Set(raw.open);
  const subs = Object.entries(files)
    .filter(([p]) => p.startsWith(dir))
    .map(([path, s]) => {
      const rel = path.slice(dir.length).replace(/\.jsonl$/, "");
      const state = s.exit ? "done" : open.has(path) ? "running" : "stopped";
      return { ...s, path, rel, name: rel.split("/").pop(), depth: rel.split("/").length - 1, top: rel.split("/")[0], state };
    });
  // Groups by top-level sub-agent: live ones first, then newest; each group parent-first.
  const groups = new Map();
  for (const s of subs) {
    const g = groups.get(s.top) ?? { running: false, started: "", items: [] };
    g.running ||= s.state === "running";
    if (s.depth === 0 || !g.started) g.started = s.started ?? g.started;
    g.items.push(s);
    groups.set(s.top, g);
  }
  const ordered = [...groups.values()]
    .sort((a, b) => Number(b.running) - Number(a.running) || (b.started > a.started ? 1 : b.started < a.started ? -1 : 0))
    .flatMap((g) => g.items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)));
  const finished = {};
  for (const s of subs) if (s.state === "done") finished[s.path] = files[s.path];
  const subCost = subs.reduce((n, s) => n + (s.cost ?? 0), 0);
  const subTokens = subs.reduce((n, s) => n + (s.tok?.total ?? 0), 0);
  const counts = { running: 0, stopped: 0, done: 0 };
  for (const s of subs) counts[s.state]++;
  return { main, subs: ordered, finished, counts, subCost, subTokens, total: (main.cost ?? 0) + subCost };
}

export function fmtTokens(n) {
  n = n ?? 0;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

export function fmtCost(c) {
  c = c ?? 0;
  if (c === 0) return "$0";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 100) return `$${c.toFixed(2)}`;
  return `$${Math.round(c)}`;
}

// "<1m", "12m", "3h", "2d" since an ISO time.
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const m = Math.floor(Math.max(0, now - t) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
