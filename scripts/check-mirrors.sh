#!/usr/bin/env bash
# A mod cannot import another mod's files, so a few modules exist as copies. They must stay identical (apart
# from a leading "// Mirror of ..." comment). Exit 1 when a pair differs or only one side exists.
# Add a pair per line: "<original> <copy>".
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PAIRS=(
  "mods/git-remote/platform.js mods/git-hub/platform.js"
  "mods/git-remote/diff.js mods/git-graph/diff.js"
  "mods/git-graph/filetree.js mods/git-remote/filetree.js"
  "mods/git-remote/highlight.js mods/git-graph/highlight.js"
  "mods/git-remote/diffview.js mods/git-graph/diffview.js"
)

body() { grep -v '^// Mirror of ' "$1"; }

bad=0
for pair in "${PAIRS[@]}"; do
  read -r a b <<<"$pair"
  if [ ! -f "$a" ] && [ ! -f "$b" ]; then continue; fi
  if [ ! -f "$a" ] || [ ! -f "$b" ]; then echo "MISSING: $a / $b (only one side exists)"; bad=1; continue; fi
  if ! diff -u <(body "$a") <(body "$b") >/dev/null; then
    echo "DIFFERS: $a vs $b"; diff -u <(body "$a") <(body "$b") | head -20; bad=1
  else
    echo "ok: $a = $b"
  fi
done
exit $bad
