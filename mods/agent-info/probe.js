// Reads a coding agent's session files (omp, Claude Code, Codex) on its own machine and shapes them for the panel.
// No mod-side file reads: session files pass readTextFile's 1 MiB cap, so jq sums them where they live.

// Sets $JQ, or prints {"error":"nojq"} and exits. macOS ships /usr/bin/jq; Homebrew's is often off a bare PATH.
const FIND_JQ = String.raw`
JQ=$(command -v jq 2>/dev/null)
if [ -z "$JQ" ]; then for c in /opt/homebrew/bin/jq /usr/local/bin/jq /usr/bin/jq; do [ -x "$c" ] && JQ=$c && break; done; fi
[ -z "$JQ" ] && { echo '{"error":"nojq"}'; exit 0; }
`;

// Model facts omp keeps for its own math: per-million rates (Claude Code and Codex logs carry tokens but no
// cost) and context windows. Keyed by model id; Anthropic and OpenAI rows win over resellers' copies.
// {} when omp (or sqlite3) isn't on that machine: costs then show as unknown and context as tokens only.
export const MODELS = FIND_JQ + String.raw`
db=$HOME/.omp/agent/models.db
if [ -f "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$db" "select models from model_cache order by provider_id in ('anthropic','openai')" 2>/dev/null \
    | "$JQ" -c -s '[.[][] | {(.id): {cost, window: .contextWindow}}] | add // {}' 2>/dev/null
else echo '{}'; fi`;

// Lines arrive as "<file>:<json>" (grep -H). jq reads them raw: the file being appended may end in half a
// line, and one bad line must not drop the rest. Each file's state, keyed by path, in one shape for all kinds.
export const JQ_PROG = String.raw`
def txt: if type == "string" then . elif type == "array" then (map(if type == "string" then . elif type == "object" then (.text // empty) else empty end) | join("\n")) else "" end;
def clip($n): if length > $n then .[:$n] + "…" else . end;
def rate($m; $prompt): ($models[$m // ""].cost // null) as $p
  | if $p == null then null elif $p.longContext != null and $prompt > ($p.longContext.inputThreshold // 1e18) then $p.longContext else $p end;
# Per-million rates; a one-hour cache write costs twice the input rate.
def bill($m; $in; $out; $cr; $cw; $cw1h): rate($m; $in + $cr + $cw + $cw1h) as $r
  | if $r == null then .unpriced = true
    else .cost += (($in * ($r.input // 0) + $out * ($r.output // 0) + $cr * ($r.cacheRead // 0) + $cw * ($r.cacheWrite // 0) + $cw1h * 2 * ($r.input // 0)) / 1000000) end;
def toks($in; $out; $cr; $cw): .tok.input += $in | .tok.output += $out | .tok.cacheRead += $cr | .tok.cacheWrite += $cw | .tok.total += ($in + $out + $cr + $cw);

# What tells you whether to step in: the agent's own task list, failing tools, and what it produced.
def plan($items): ($items // []) | if type == "array" and length > 0 then
  map(select(.status != "abandoned" and .status != "dropped")) as $l
  | {total: ($l | length), done: ($l | map(select(.status == "completed")) | length),
     current: ($l | map(select(.status == "in_progress")) | first | (.content // .activeForm // null))}
  else null end;
def toolres($err; $tool; $text): if $err
  then .toolErrors += 1 | .errStreak += 1 | .toolError = {tool: $tool, text: ($text | tostring | clip(300))}
  else .errStreak = 0 end;
def touched($p): if ($p | type) == "string" and $p != "" and ($p | test("://") | not) then .touched[$p] = true else . end;
def prurl($t): [($t // "") | tostring | match("https://github\\.com/[^\\s\"'<>)]+/pull/[0-9]+"; "g").string] | last;

# omp writes its own usage and cost on every reply and side call (titles, auto-thinking).
def use($u): if $u == null then . else
  .tok.input += ($u.input // 0) | .tok.output += ($u.output // 0)
  | .tok.cacheRead += ($u.cacheRead // 0) | .tok.cacheWrite += ($u.cacheWrite // 0)
  | .tok.total += ($u.totalTokens // 0) | .cost += ($u.cost.total // 0) end;
def omp($e):
  if $e.type == "session" then .id = $e.id | .cwd = $e.cwd | .started = $e.timestamp
  elif $e.type == "title" or $e.type == "title_change" then (if ($e.title // "") != "" then .title = $e.title else . end)
  elif $e.type == "session_init" then .task = (($e.task // "") | clip(1500)) | .agent = $e.agent | .model = ($e.resolvedModel // .model)
  elif $e.type == "message" then
    $e.message as $m
    | if $m.role == "assistant" then
        use($m.usage) | .replies += 1
        | .model = (($m.provider // "") + "/" + ($m.model // ""))
        | .ctx = (($m.usage.input // 0) + ($m.usage.cacheRead // 0) + ($m.usage.cacheWrite // 0) + ($m.usage.output // 0))
        | .error = (if $m.errorMessage then ($m.errorMessage | tostring | clip(300)) else null end)
        | (($m.content | txt) as $t | if $t != "" then .reply = ($t | clip(1500)) else . end)
        | reduce ($m.content // [] | if type == "array" then .[] else empty end | select(.type == "toolCall")) as $c (.;
            ($c.arguments // {}) as $a
            | if $c.name == "write" then touched($a.path)
              elif $c.name == "edit" then touched($a.path)
                | reduce (($a.input // "") | tostring | [match("(?m)^\\[([^\\]\\n#]+)#[0-9A-Za-z]{4}\\]"; "g").captures[0].string] | .[]) as $f (.; touched($f))
              elif $c.name == "bash" and (($a.command // "") | tostring | test("gh pr create")) then .prPending = true
              else . end)
      elif $m.role == "user" then .prompts += 1 | .prompt = (($m.content | txt) | clip(1500))
      elif $m.role == "toolResult" then ($m.content | txt) as $t
        | toolres($m.isError == true; $m.toolName; $t)
        | (if .prPending and $m.toolName == "bash" then (prurl($t) as $u | if $u then .pr = $u else . end) | .prPending = false else . end)
        | (if $m.toolName == "todo" and $m.details.phases then .plan = plan([$m.details.phases[]?.tasks[]?]) else . end)
      else . end
  elif $e.type == "model_usage" then use($e.usage) | .aux += ($e.usage.cost.total // 0)
  elif $e.type == "compaction" then .compactions += 1
    | .compaction = {at: $e.timestamp, short: $e.shortSummary, summary: (($e.summary // "") | clip(4000)), before: $e.tokensBefore, after: $e.tokensAfter}
  elif $e.type == "custom" and $e.customType == "tool_execution_start" then
    ($e.data // {}) as $d | .doing = {tool: $d.toolName, intent: $d.intent, at: ($d.startedAt // $e.timestamp)}
  elif $e.type == "custom" and $e.customType == "todo_hud_state" then
    .plan = plan([($e.data.fingerprint // "[]" | fromjson? // []) | .[]?.tasks[]?])
  elif $e.type == "custom" and $e.customType == "session_exit" then .exit = ($e.data // {})
  else . end;

# Claude Code writes one line per content block, each repeating the reply's usage: count a reply once, by id.
def claude($e):
  (if .id == null and $e.sessionId then .id = $e.sessionId | .cwd = $e.cwd else . end)
  | (if .started == null and $e.timestamp then .started = $e.timestamp else . end)
  | if $e.type == "assistant" and ($e.message.model // "") != "<synthetic>" then
      $e.message as $m | ($m.usage // {}) as $u
      | .model = $m.model | .error = null
      | (if .seen[$m.id // $e.uuid] then . else
          .seen[$m.id // $e.uuid] = true | .replies += 1
          | ($u.cache_creation.ephemeral_1h_input_tokens // 0) as $h
          | toks($u.input_tokens // 0; $u.output_tokens // 0; $u.cache_read_input_tokens // 0; $u.cache_creation_input_tokens // 0)
          | .ctx = (($u.input_tokens // 0) + ($u.cache_read_input_tokens // 0) + ($u.cache_creation_input_tokens // 0) + ($u.output_tokens // 0))
          | bill($m.model; $u.input_tokens // 0; $u.output_tokens // 0; $u.cache_read_input_tokens // 0; ($u.cache_creation_input_tokens // 0) - $h; $h)
        end)
      | reduce ($m.content // [] | if type == "array" then .[] else empty end) as $c (.;
          if $c.type == "text" and ($c.text // "") != "" then .reply = ($c.text | clip(1500))
          elif $c.type == "tool_use" then ($c.input // {}) as $in
            | .doing = {tool: $c.name, at: $e.timestamp,
                intent: ($in | (.description // .file_path // .pattern // .command // .prompt // .url // "") | tostring | clip(160))}
            | (if ($c.name | test("^(Edit|Write|MultiEdit|NotebookEdit)$")) then touched($in.file_path // $in.notebook_path) else . end)
            | (if ($c.name | test("(^|__)(TodoWrite|update_plan)$")) then .plan = plan($in.todos // $in.items) else . end)
          else . end)
    elif $e.type == "assistant" and $e.isApiErrorMessage then .error = (($e.message.content | txt) | clip(300))
    elif $e.type == "user" and $e.isCompactSummary then .compaction.summary = (($e.message.content | txt) | clip(4000))
    elif $e.type == "user" and ($e.message.content | type) == "array" and any($e.message.content[]; .type? == "tool_result") then
      reduce ($e.message.content[] | select(.type? == "tool_result")) as $r (.; toolres($r.is_error == true; null; $r.content | txt))
    elif $e.type == "user" and $e.parentUuid == null and .task == null then .task = (($e.message.content | txt) | clip(1500))
    elif $e.type == "custom-title" then .title = $e.customTitle | .titled = true
    elif $e.type == "agent-name" and (.titled | not) then .title = $e.agentName
    elif $e.type == "ai-title" and (.titled | not) then .title = $e.aiTitle
    elif $e.type == "last-prompt" and ($e.lastPrompt // "") != "" then .prompt = ($e.lastPrompt | clip(1500))
    elif $e.type == "cost-state" then .selfCost = $e.totalCostUSD | .selfCostAt = .last
      | .lines = {added: ($e.totalLinesAdded // 0), removed: ($e.totalLinesRemoved // 0)}
    elif $e.type == "pr-link" and $e.prUrl then .pr = $e.prUrl
    elif $e.type == "system" and $e.subtype == "turn_duration" then .prompts += 1
    elif $e.type == "system" and $e.subtype == "compact_boundary" then .compactions += 1
      | .compaction = {at: $e.timestamp, short: ($e.compactMetadata.trigger // null), summary: .compaction.summary,
          before: $e.compactMetadata.preTokens, after: $e.compactMetadata.postTokens}
    else . end;

# Codex keeps running totals (token_count) and one record per response (token_usage_record, priced here).
def codex($e): $e.payload as $p
  | if $e.type == "session_meta" then
      .id = $p.id | .cwd = $p.cwd | .started = $p.timestamp | .parentThread = $p.parent_thread_id
      | ($p.source | if type == "object" then .subagent else null end) as $sub
      | .agent = ($sub | if type == "string" then . elif type == "object" then (.thread_spawn.agent_role // .thread_spawn.agent_nickname // (keys[0])) else null end)
      | .name = ($sub | if type == "object" then .thread_spawn.agent_nickname else null end)
    elif $e.type == "turn_context" then .model = $p.model
    elif $e.type == "token_usage_record" then ($p.usage // {}) as $u
      | .replies += 1
      | bill(.model; ($u.input_tokens // 0) - ($u.cached_input_tokens // 0); $u.output_tokens // 0; $u.cached_input_tokens // 0; $u.cache_write_input_tokens // 0; 0)
    elif $e.type == "compacted" then .compactions += 1
      | .compaction = {at: $e.timestamp, short: null, summary: (($p.message // "") | tostring | clip(4000)), before: null, after: null}
    elif $e.type == "event_msg" and $p.type == "token_count" then
      (if $p.info then ($p.info.total_token_usage // {}) as $t | ($p.info.last_token_usage // {}) as $l
        | .tok = {input: (($t.input_tokens // 0) - ($t.cached_input_tokens // 0)), output: ($t.output_tokens // 0),
            cacheRead: ($t.cached_input_tokens // 0), cacheWrite: ($t.cache_write_input_tokens // 0), total: ($t.total_tokens // 0)}
        | .ctx = (($l.input_tokens // 0) + ($l.output_tokens // 0)) | .window = $p.info.model_context_window
       else . end)
      | (if $p.rate_limits then .limits = ($p.rate_limits | {primary, secondary}) else . end)
    elif $e.type == "event_msg" and $p.type == "task_started" then .busy = true | .prompts += 1
    elif $e.type == "event_msg" and $p.type == "task_complete" then .busy = false
      | (if ($p.last_agent_message // "") != "" then .reply = ($p.last_agent_message | clip(1500)) else . end)
    elif $e.type == "event_msg" and $p.type == "item_completed" then ($p.item // {}) as $i
      | if $i.type == "UserMessage" then (($i.content | txt) as $t | .prompt = ($t | clip(1500)) | (if .task == null then .task = ($t | clip(1500)) else . end))
        elif $i.type == "AgentMessage" then (($i.content | txt) as $t | if $t != "" then .reply = ($t | clip(1500)) else . end)
        elif $i.type == "CommandExecution" then ($i.aggregated_output // "" | tostring) as $out
          | .doing = {tool: "shell", intent: ($i.command | tostring | clip(160)), at: $e.timestamp}
          | toolres(($i.exit_code // 0) != 0; "shell"; $out)
          | (if ($i.command | tostring | test("gh pr create")) then (prurl($out) as $u | if $u then .pr = $u else . end) else . end)
        else . end
    elif $e.type == "response_item" and ($p.type == "function_call" or $p.type == "custom_tool_call") then
      .doing = {tool: $p.name, intent: (($p.arguments // $p.input // "") | tostring | clip(160)), at: $e.timestamp}
    else . end;

def step($e): (if $e.timestamp then .last = $e.timestamp else . end)
  | if $kind == "claude" then claude($e) elif $kind == "codex" then codex($e) else omp($e) end;

reduce (inputs | index(":{") as $i | select($i != null) | {f: .[:$i], e: (.[$i + 1:] | fromjson?)} | select(.e | type == "object")) as $x
  ({}; if $kind == "claude" and $x.f == $main and $x.e.isSidechain == true then . else .[$x.f] |= step($x.e) end)
| map_values(del(.seen, .titled, .prPending)
    | .touched = ((.touched // {}) | keys)
    | (if .window == null then .window = $models[(.model // "") | split("/") | last | sub(":.*$"; "")].window else . end))
| (if $kind == "claude" then with_entries(.value += (($metas[.key] // null) as $m
    | if $m then {name: $m.description, agent: $m.agentType, finished: $m.finished} else {} end)) else . end)
| (if $title != "" then .[$main].title = $title else . end)
| {kind: $kind, main: $main, estimated: ($kind != "omp"), open: ($open | split("\n") | map(select(. != ""))), files: .}`;

// sh -c PROBE sh <kind> <pid> <finished paths, one per line> <JQ_PROG> <MODELS JSON>
// The agent's process and its descendants (Codex writes from a child of its launcher) give the files:
// - omp: the session files it holds open (lsof -n -P: no DNS, fast); the shallowest is the main one, the
//   others live sub-agents; finished sub-agents come from the session's folder.
// - Claude Code: ~/.claude/sessions/<pid>.json names the session; sub-agents sit in <session>/subagents
//   with a .meta.json each (type, description, finished).
// - Codex: the open rollout whose thread is its own root; sub-agents are later rollouts naming it as their session.
// Already-summarized finished files are skipped: they never change again.
export const PROBE = FIND_JQ + String.raw`
kind=$1; pid=$2; skip=$3; prog=$4; models=$5
[ -n "$models" ] || models='{}'
pids=$(ps -A -o pid= -o ppid= | awk -v root="$pid" '{ parent[$1] = $2 } END { seen[root] = 1; grew = 1; while (grew) { grew = 0; for (p in parent) if (!(p in seen) && (parent[p] in seen)) { seen[p] = 1; grew = 1 } } sep = ""; for (p in seen) { printf "%s%s", sep, p; sep = "," } }')
open=$(lsof -n -P -p "$pids" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -E '\.jsonl$' | sort -u)
title=""; metas='{}'; main=""
case $kind in
omp)
  open=$(printf '%s\n' "$open" | grep -E '/sessions/.+\.jsonl$')
  main=$(printf '%s\n' "$open" | grep -v '^$' | awk -F/ '{ print NF "\t" $0 }' | sort -n | head -n 1 | cut -f 2-)
  [ -n "$main" ] && subs=$(find "$(printf '%s' "$main" | sed 's/\.jsonl$//')" -type f -name '*.jsonl' 2>/dev/null)
  filter='^' ;;
claude)
  base=$CLAUDE_CONFIG_DIR; [ -n "$base" ] || base=$HOME/.claude
  open=""
  for p in $(printf '%s' "$pids" | tr ',' ' '); do
    [ -f "$base/sessions/$p.json" ] || continue
    sid=$("$JQ" -r '.sessionId // empty' "$base/sessions/$p.json" 2>/dev/null)
    [ -n "$sid" ] && main=$(find "$base/projects" -maxdepth 2 -name "$sid.jsonl" 2>/dev/null | head -n 1)
    [ -n "$main" ] && break
  done
  if [ -n "$main" ]; then
    dir=$(printf '%s' "$main" | sed 's/\.jsonl$//')/subagents
    subs=$(find "$dir" -maxdepth 1 -type f -name '*.jsonl' 2>/dev/null)
    metas=$(find "$dir" -maxdepth 1 -type f -name '*.meta.json' 2>/dev/null | tr '\n' '\0' \
      | xargs -0 "$JQ" -c -n '[inputs | {(input_filename | sub("\\.meta\\.json$"; ".jsonl")): .}] | add // {}' 2>/dev/null)
    [ -n "$metas" ] || metas='{}'
  fi
  filter='"type":"(assistant|cost-state|ai-title|custom-title|agent-name|last-prompt|pr-link|tool_result)"|"subtype":"(compact_boundary|turn_duration)"|"isCompactSummary":true|"parentUuid":null' ;;
codex)
  base=$CODEX_HOME; [ -n "$base" ] || base=$HOME/.codex
  open=$(printf '%s\n' "$open" | grep -E '/rollout-[^/]*\.jsonl$')
  first=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -n "$first" ] || first=$f
    [ "$(head -n 1 "$f" | "$JQ" -r '.payload | (.session_id == null or .id == .session_id)' 2>/dev/null)" = true ] && main=$f && break
  done <<EOF
$open
EOF
  [ -n "$main" ] || main=$first
  if [ -n "$main" ]; then
    id=$(head -n 1 "$main" | "$JQ" -r '.payload.id // empty')
    name=$(basename "$main")
    subs=$(find "$base/sessions" -type f -name 'rollout-*.jsonl' 2>/dev/null | awk -F/ -v n="$name" '$NF > n' \
      | while IFS= read -r f; do head -n 1 "$f" | grep -qF "\"session_id\":\"$id\"" && printf '%s\n' "$f"; done)
    title=$(grep -F "\"id\":\"$id\"" "$base/session_index.jsonl" 2>/dev/null | tail -n 1 | "$JQ" -r '.thread_name // empty' 2>/dev/null)
  fi
  filter='"type":"(session_meta|turn_context|token_count|token_usage_record|task_started|task_complete|item_completed|function_call|custom_tool_call|compacted)"' ;;
*) echo '{"error":"unsupported"}'; exit 0 ;;
esac
[ -z "$main" ] && { echo '{"error":"nosession"}'; exit 0; }
[ -n "$skip" ] && subs=$(printf '%s\n' "$subs" | grep -vxF -e "$skip")
printf '%s\n' "$main" "$subs" | grep -v '^$' | tr '\n' '\0' | xargs -0 grep -H -E -e "$filter" 2>/dev/null \
  | "$JQ" -n -R -c --arg kind "$kind" --arg main "$main" --arg open "$open" --arg title "$title" \
      --argjson metas "$metas" --argjson models "$models" "$prog"`;

const base = (p) => p.split("/").pop().replace(/\.jsonl$/, "");

// Done / running / stopped (neither: it died or was dropped), from what each agent writes.
function stateOf(kind, s, open) {
  if (kind === "claude") return s.finished === true ? "done" : s.finished === false ? "running" : "unknown";
  if (kind === "codex") return s.busy === false ? "done" : open ? "running" : "stopped";
  return s.exit ? "done" : open ? "running" : "stopped";
}

// Where each sub-agent sits: `rel` orders a group parent-first, `top` names its group.
function place(kind, mainPath, subs) {
  if (kind === "omp") {
    const dir = mainPath.replace(/\.jsonl$/, "") + "/";
    for (const s of subs) {
      const rel = s.path.startsWith(dir) ? s.path.slice(dir.length).replace(/\.jsonl$/, "") : base(s.path);
      Object.assign(s, { rel, name: rel.split("/").pop(), depth: rel.split("/").length - 1, top: rel.split("/")[0] });
    }
    return;
  }
  // Codex threads name their parent thread; Claude Code's sub-agents are one flat folder.
  const byId = new Map(subs.filter((s) => s.id).map((s) => [s.id, s]));
  for (const s of subs) {
    const chain = [];
    for (let p = s.parentThread, guard = 0; kind === "codex" && p && byId.has(p) && guard < 16; p = byId.get(p).parentThread, guard++) chain.unshift(byId.get(p));
    const key = (x) => `${x.started ?? ""}~${x.id ?? x.path}`;
    Object.assign(s, {
      rel: [...chain, s].map(key).join("/"),
      depth: chain.length,
      top: key(chain[0] ?? s),
      name: s.name || s.agent || (kind === "codex" ? (s.id ?? "").slice(-8) : base(s.path)),
    });
  }
}

// Raw probe output + finished sub-agents kept from earlier probes → what the panel shows.
// `finished`: the sub-agents that ended, to skip next time (pass back as `kept`). A Codex thread can
// take more work after it finishes, so Codex keeps none.
export function shape(raw, kept = {}) {
  const kind = raw.kind ?? "omp";
  const files = { ...kept, ...raw.files };
  const main = { path: raw.main, ...files[raw.main] };
  const open = new Set(raw.open);
  const subs = Object.entries(files)
    .filter(([p]) => p !== raw.main)
    .map(([path, s]) => ({ ...s, path, state: stateOf(kind, s, open.has(path)) }));
  place(kind, raw.main, subs);
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
  if (kind !== "codex") for (const s of subs) if (s.state === "done") finished[s.path] = files[s.path];
  const subCost = subs.reduce((n, s) => n + (s.cost ?? 0), 0);
  const subTokens = subs.reduce((n, s) => n + (s.tok?.total ?? 0), 0);
  const counts = { running: 0, stopped: 0, done: 0 };
  for (const s of subs) counts[s.state] = (counts[s.state] ?? 0) + 1;
  const unpriced = Boolean(main.unpriced) || subs.some((s) => s.unpriced);
  return { kind, estimated: Boolean(raw.estimated), unpriced, main, subs: ordered, finished, counts, subCost, subTokens, total: (main.cost ?? 0) + subCost };
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
