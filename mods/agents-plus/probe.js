// Mirror of mods/agent-info/probe.js: a mod cannot import another mod's files. Change both together.
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

// One session file's new lines folded into the state saved from its last read (--slurpfile prev: [] for none,
// else [{off, f, s}]); prints the next {off, f, s}. Lines are raw: one bad line must not drop the rest.
// The state has one shape for all kinds.
export const JQ_STEP = String.raw`
def txt: if type == "string" then . elif type == "array" then (map(if type == "string" then . elif type == "object" then (.text // empty) else empty end) | join("\n")) else "" end;
def clip($n): if length > $n then .[:$n] + "…" else . end;
def rate($m; $prompt): ($models[$m // ""].cost // null) as $p
  | if $p == null then null elif $p.longContext != null and $prompt > ($p.longContext.inputThreshold // 1e18) then $p.longContext else $p end;
# Per-million rates; a one-hour cache write costs twice the input rate.
def bill($m; $in; $out; $cr; $cw; $cw1h): rate($m; $in + $cr + $cw + $cw1h) as $r
  | if $r == null then .unpriced = true
    else .cost += (($in * ($r.input // 0) + $out * ($r.output // 0) + $cr * ($r.cacheRead // 0) + $cw * ($r.cacheWrite // 0) + $cw1h * 2 * ($r.input // 0)) / 1000000) end;
def toks($in; $out; $cr; $cw): .tok.input += $in | .tok.output += $out | .tok.cacheRead += $cr | .tok.cacheWrite += $cw | .tok.total += ($in + $out + $cr + $cw);
# Per model: switching models mid-session splits the totals. $cost null = no price for it.
# runs: consecutive replies on one model, in order (side calls left out), the last 100 kept.
def per($k; $in; $out; $cr; $cw; $total; $cost; $aux; $ts):
  if ($k // "") == "" or ($k | endswith("/")) then . else
  (.byModel[$k] |= ((. // {tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0, aux: 0, from: $ts})
    | .tokens += $total | .input += $in | .output += $out | .cacheRead += $cr | .cacheWrite += $cw
    | .calls += 1 | (if $aux then .aux += 1 else . end) | .to = $ts
    | (if $cost == null then .unpriced = true else .cost += $cost end)))
  | if $aux then . else .runs |= ((. // [])
      | if length > 0 and .[-1].model == $k then .[-1].tokens += $total | .[-1].calls += 1 | .[-1].to = $ts
        else (. + [{model: $k, tokens: $total, calls: 1, from: $ts, to: $ts}])[-100:] end) end end;

# What tells you whether to step in: the agent's own task list, failing tools, and what it produced.
def plan($items): ($items // []) | if type == "array" and length > 0 then
  map(select(.status != "abandoned" and .status != "dropped")) as $l
  | {total: ($l | length), done: ($l | map(select(.status == "completed")) | length),
     current: ($l | map(select(.status == "in_progress")) | first | (.content // .activeForm // null)),
     items: ($l[:40] | map({text: ((.content // .activeForm // "") | tostring | clip(160)), status}))}
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
        | ($m.usage // {}) as $u
        | per(($m.provider // "") + "/" + ($m.model // ""); $u.input // 0; $u.output // 0; $u.cacheRead // 0; $u.cacheWrite // 0; $u.totalTokens // 0; $u.cost.total // 0; false; .last)
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
      elif $m.role == "user" then .prompts += 1 | .prompt = (($m.content | txt) | clip(1500)) | .promptAt = $e.timestamp
      elif $m.role == "toolResult" then ($m.content | txt) as $t
        | toolres($m.isError == true; $m.toolName; $t)
        | (if .prPending and $m.toolName == "bash" then (prurl($t) as $u | if $u then .pr = $u else . end) | .prPending = false else . end)
        | (if $m.toolName == "todo" and $m.details.phases then .plan = plan([$m.details.phases[]?.tasks[]?]) else . end)
      else . end
  elif $e.type == "model_usage" then use($e.usage) | .aux += ($e.usage.cost.total // 0)
    | ($e.usage // {}) as $u
    | per(($e.provider // "") + "/" + ($e.model // ""); $u.input // 0; $u.output // 0; $u.cacheRead // 0; $u.cacheWrite // 0; $u.totalTokens // 0; $u.cost.total // 0; true; .last)
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
          | .cost as $c0
          | bill($m.model; $u.input_tokens // 0; $u.output_tokens // 0; $u.cache_read_input_tokens // 0; ($u.cache_creation_input_tokens // 0) - $h; $h)
          | per($m.model; $u.input_tokens // 0; $u.output_tokens // 0; $u.cache_read_input_tokens // 0; $u.cache_creation_input_tokens // 0;
              ($u.input_tokens // 0) + ($u.output_tokens // 0) + ($u.cache_read_input_tokens // 0) + ($u.cache_creation_input_tokens // 0);
              (if $models[$m.model // ""].cost == null then null else (.cost // 0) - ($c0 // 0) end); false; .last)
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
      | .cost as $c0
      | bill(.model; ($u.input_tokens // 0) - ($u.cached_input_tokens // 0); $u.output_tokens // 0; $u.cached_input_tokens // 0; $u.cache_write_input_tokens // 0; 0)
      | per(.model; ($u.input_tokens // 0) - ($u.cached_input_tokens // 0); $u.output_tokens // 0; $u.cached_input_tokens // 0; $u.cache_write_input_tokens // 0;
          $u.total_tokens // (($u.input_tokens // 0) + ($u.output_tokens // 0));
          (if $models[.model // ""].cost == null then null else (.cost // 0) - ($c0 // 0) end); false; .last)
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
      | if $i.type == "UserMessage" then (($i.content | txt) as $t | .prompt = ($t | clip(1500)) | .promptAt = $e.timestamp | (if .task == null then .task = ($t | clip(1500)) else . end))
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

reduce (inputs | fromjson? | select(type == "object")) as $e ($prev[0].s // {};
  if $kind == "claude" and $isMain and $e.isSidechain == true then . else step($e) end)
# A Claude reply's repeated blocks sit together: its latest ids are enough to count each reply once.
| (if .seen then .seen |= (to_entries[-200:] | from_entries) else . end)
| {off: $off, f: $f, s: .}`;

// A saved state as shown: bookkeeping dropped, the context window from omp's table when the log has none.
const FIN = String.raw`
def fin: del(.seen, .titled, .prPending)
  | .touched = ((.touched // {}) | keys)
  | (if .window == null then .window = $models[(.model // "") | split("/") | last | sub(":.*$"; "")].window else . end);
`;

// The saved states of one agent's files → what PROBE prints.
export const JQ_FINAL = FIN + String.raw`
reduce inputs as $x ({}; .[$x.f] = ($x.s | fin))
| (if $kind == "claude" then with_entries(.value += (($metas[.key] // null) as $m
    | if $m then {name: $m.description, agent: $m.agentType, finished: $m.finished} else {} end)) else . end)
| (if $title != "" then .[$main].title = $title else . end)
| {kind: $kind, main: $main, estimated: ($kind != "omp"), open: ($open | split("\n") | map(select(. != ""))), files: .}`;

// {a: address, x: saved state} or {a, fail} per agent → what SUMMARY prints: the few fields a list row shows.
export const JQ_BRIEF = FIN + String.raw`
inputs | {a} + (if .fail then {fail} else (.x.s | fin
  | {last, ctx, window, error, errStreak, toolError, pr, cost, unpriced, plan: (.plan | if . then {total, done, current} else null end)}) end)`;

// locate <kind> <pid> [subs]: sets main (the session file) and filter (the lines worth reading); with "subs",
// also subs, open, title and metas. Returns 1 for an unsupported kind. Needs $ptab (ps -A -o pid= -o ppid=).
// The agent's process and its descendants (Codex writes from a child of its launcher) give the files:
// - omp: the session files it holds open (lsof -n -P: no DNS, fast); the shallowest is the main one, the
//   others live sub-agents; finished sub-agents come from the session's folder.
// - Claude Code: ~/.claude/sessions/<pid>.json names the session; sub-agents sit in <session>/subagents
//   with a .meta.json each (type, description, finished).
// - Codex: the open rollout whose thread is its own root; sub-agents are later rollouts naming it as their session.
const LOCATE = String.raw`
locate() {
  main=""; subs=""; open=""; title=""; metas='{}'
  pids=$(printf '%s\n' "$ptab" | awk -v root="$2" '{ parent[$1] = $2 } END { seen[root] = 1; grew = 1; while (grew) { grew = 0; for (p in parent) if (!(p in seen) && (parent[p] in seen)) { seen[p] = 1; grew = 1 } } sep = ""; for (p in seen) { printf "%s%s", sep, p; sep = "," } }')
  case $1 in
  omp)
    open=$(lsof -n -P -p "$pids" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -E '/sessions/.+\.jsonl$' | sort -u)
    main=$(printf '%s\n' "$open" | grep -v '^$' | awk -F/ '{ print NF "\t" $0 }' | sort -n | head -n 1 | cut -f 2-)
    [ -n "$3" ] && [ -n "$main" ] && subs=$(find "$(printf '%s' "$main" | sed 's/\.jsonl$//')" -type f -name '*.jsonl' 2>/dev/null)
    filter='^' ;;
  claude)
    base=$CLAUDE_CONFIG_DIR; [ -n "$base" ] || base=$HOME/.claude
    for p in $(printf '%s' "$pids" | tr ',' ' '); do
      [ -f "$base/sessions/$p.json" ] || continue
      sid=$("$JQ" -r '.sessionId // empty' "$base/sessions/$p.json" 2>/dev/null)
      [ -n "$sid" ] && main=$(find "$base/projects" -maxdepth 2 -name "$sid.jsonl" 2>/dev/null | head -n 1)
      [ -n "$main" ] && break
    done
    if [ -n "$3" ] && [ -n "$main" ]; then
      dir=$(printf '%s' "$main" | sed 's/\.jsonl$//')/subagents
      subs=$(find "$dir" -maxdepth 1 -type f -name '*.jsonl' 2>/dev/null)
      metas=$(find "$dir" -maxdepth 1 -type f -name '*.meta.json' 2>/dev/null | tr '\n' '\0' \
        | xargs -0 "$JQ" -c -n '[inputs | {(input_filename | sub("\\.meta\\.json$"; ".jsonl")): .}] | add // {}' 2>/dev/null)
      [ -n "$metas" ] || metas='{}'
    fi
    filter='"type":"(assistant|cost-state|ai-title|custom-title|agent-name|last-prompt|pr-link|tool_result)"|"subtype":"(compact_boundary|turn_duration)"|"isCompactSummary":true|"parentUuid":null' ;;
  codex)
    base=$CODEX_HOME; [ -n "$base" ] || base=$HOME/.codex
    open=$(lsof -n -P -p "$pids" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -E '/rollout-[^/]*\.jsonl$' | sort -u)
    first=""
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      [ -n "$first" ] || first=$r
      [ "$(head -n 1 "$r" | "$JQ" -r '.payload | (.session_id == null or .id == .session_id)' 2>/dev/null)" = true ] && main=$r && break
    done <<EOF
$open
EOF
    [ -n "$main" ] || main=$first
    if [ -n "$3" ] && [ -n "$main" ]; then
      id=$(head -n 1 "$main" | "$JQ" -r '.payload.id // empty')
      name=$(basename "$main")
      subs=$(find "$base/sessions" -type f -name 'rollout-*.jsonl' 2>/dev/null | awk -F/ -v n="$name" '$NF > n' \
        | while IFS= read -r r; do head -n 1 "$r" | grep -qF "\"session_id\":\"$id\"" && printf '%s\n' "$r"; done)
      title=$(grep -F "\"id\":\"$id\"" "$base/session_index.jsonl" 2>/dev/null | tail -n 1 | "$JQ" -r '.thread_name // empty' 2>/dev/null)
    fi
    filter='"type":"(session_meta|turn_context|token_count|token_usage_record|task_started|task_complete|item_completed|function_call|custom_tool_call|compacted)"' ;;
  *) return 1 ;;
  esac
}`;

// fold <file> <true for the main session>: prints the path of the file's saved state, first brought up to date
// by reading only what was added since the last read. A line still being written (no newline yet) waits for
// the next read. A file that shrank is read again from the start. Needs $cache, $kind, $filter, $step, $models.
// The state lives on the agent's machine, keyed by path, in a folder named after the program and the rates:
// a change to either starts over.
const FOLD = String.raw`
cache=$TMPDIR; [ -n "$cache" ] || cache=/tmp
cache=$cache/herdr-agent-info-$(printf '%s%s' "$step" "$models" | cksum | cut -d ' ' -f 1)
(umask 077; mkdir -p "$cache")
fold() {
  _st=$cache/$(printf '%s' "$1" | cksum | cut -d ' ' -f 1).json
  _size=$(wc -c < "$1" 2>/dev/null | tr -d ' ')
  [ -n "$_size" ] || return 0
  _off=0; _prev=/dev/null
  if [ -s "$_st" ]; then _off=$(sed -n '1s/^{"off":\([0-9]*\),.*/\1/p' "$_st"); _prev=$_st; fi
  if [ -z "$_off" ] || [ "$_off" -gt "$_size" ]; then _off=0; _prev=/dev/null; rm -f "$_st"; fi
  _end=$_size
  if [ "$_size" -gt "$_off" ] && [ "$(tail -c +"$_size" "$1" | head -c 1 | wc -l | tr -d ' ')" != 1 ]; then
    _end=$((_size - $(tail -c +$((_off + 1)) "$1" | head -c $((_size - _off)) | LC_ALL=C awk 'END { print length($0) }')))
  fi
  if [ "$_end" -gt "$_off" ]; then
    tail -c +$((_off + 1)) "$1" | head -c $((_end - _off)) | grep -E -e "$filter" \
      | "$JQ" -n -R -c --arg kind "$kind" --argjson isMain "$2" --arg f "$1" --argjson off "$_end" \
          --argjson models "$models" --slurpfile prev "$_prev" "$step" > "$_st.$$" && mv "$_st.$$" "$_st"
  fi
  [ -s "$_st" ] && printf '%s\n' "$_st"
}`;

// sh -c PROBE sh <kind> <pid> <finished paths, one per line> <JQ_STEP> <JQ_FINAL> <MODELS JSON>
// One agent's main session and sub-agents. Already-summarized finished files are skipped: they never change again.
export const PROBE = FIND_JQ + String.raw`
kind=$1; pid=$2; skip=$3; step=$4; final=$5; models=$6
[ -n "$models" ] || models='{}'
` + FOLD + LOCATE + String.raw`
ptab=$(ps -A -o pid= -o ppid=)
locate "$kind" "$pid" subs || { echo '{"error":"unsupported"}'; exit 0; }
[ -z "$main" ] && { echo '{"error":"nosession"}'; exit 0; }
[ -n "$skip" ] && subs=$(printf '%s\n' "$subs" | grep -vxF -e "$skip")
printf '%s\n' "$main" "$subs" | grep -v '^$' | while IFS= read -r x; do
  if [ "$x" = "$main" ]; then fold "$x" true; else fold "$x" false; fi
done | while IFS= read -r st; do cat "$st"; done \
  | "$JQ" -n -c --arg kind "$kind" --arg main "$main" --arg open "$open" --arg title "$title" \
      --argjson metas "$metas" --argjson models "$models" "$final"`;

// sh -c SUMMARY sh <"address kind pid" per line> <JQ_STEP> <JQ_BRIEF> <MODELS JSON>
// Every listed agent on one machine, main sessions only, in one run: one JSON line per agent.
export const SUMMARY = FIND_JQ + String.raw`
list=$1; step=$2; brief=$3; models=$4
[ -n "$models" ] || models='{}'
` + FOLD + LOCATE + String.raw`
ptab=$(ps -A -o pid= -o ppid=)
printf '%s\n' "$list" | while read -r addr kind pid; do
  [ -n "$addr" ] || continue
  if ! locate "$kind" "$pid"; then printf '{"a":"%s","fail":"unsupported"}\n' "$addr"; continue; fi
  [ -z "$main" ] && { printf '{"a":"%s","fail":"nosession"}\n' "$addr"; continue; }
  st=$(fold "$main" true)
  if [ -n "$st" ]; then printf '{"a":"%s","x":' "$addr"; cat "$st"; printf '}\n'
  else printf '{"a":"%s","fail":"empty"}\n' "$addr"; fi
done | "$JQ" -c -n --argjson models "$models" "$brief"`;

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

export const STALE_MS = 10 * 60000; // "working" with nothing logged for this long: likely stuck
export const CTX_WARN = 85; // context % worth a warning
export const STREAK_WARN = 3; // tool failures in a row worth a warning

export const firstLine = (s) => (s ?? "").split("\n").find((l) => l.trim()) ?? "";
export const ctxPct = (m) => (m?.window && m.ctx != null ? Math.round((m.ctx / m.window) * 100) : null);

// The program in an agent pane as the probe reads it; null for one it can't.
export function kindOf(a) {
  const names = [a?.app, a?.program?.key];
  if (names.includes("omp")) return "omp";
  if (names.includes("claude") || names.includes("claude-code")) return "claude";
  if (names.includes("codex")) return "codex";
  return null;
}

// Reasons to look now, from a session's state and the agent's status. Each names what the log shows,
// not a guess at the cause: `short` fits a list row, `head` and `detail` explain.
export function alertsOf(m, status, now = Date.now()) {
  const list = [];
  if (m.error) list.push({ key: "api", short: "API 錯誤", head: "API 錯誤", detail: m.error });
  if ((m.errStreak ?? 0) >= STREAK_WARN) {
    const tool = m.toolError?.tool ? `（${m.toolError.tool}）` : "";
    list.push({ key: "tools", short: `失敗 ×${m.errStreak}`, head: `工具連續失敗 ${m.errStreak} 次${tool}`, detail: firstLine(m.toolError?.text) });
  }
  if (status === "working" && m.last && now - Date.parse(m.last) > STALE_MS)
    list.push({ key: "stale", short: `${ago(m.last, now)} 沒動靜`, head: `顯示工作中，但已 ${ago(m.last, now)} 沒有新紀錄`, detail: "可能卡住，或在跑很久的指令" });
  const p = ctxPct(m);
  if (p >= CTX_WARN) list.push({ key: "ctx", short: `上下文 ${p}%`, head: `上下文已用 ${p}%`, detail: "接近上限，之後會壓縮或需要開新 session" });
  return list;
}

// omp's model rates and context windows on a machine (null: this one), read at most hourly.
// `cache`: a Map the caller keeps; `run`: herdr's exec.
export async function modelsFor(cache, run, on) {
  const key = on ?? "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600000) return hit.json;
  const json = (await run("sh", ["-c", MODELS], { on, timeout: 20000 })).stdout.trim() || "{}";
  cache.set(key, { json, at: Date.now() });
  return json;
}
