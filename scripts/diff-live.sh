#!/usr/bin/env bash
# What the repo ships vs what actually runs in ~/.config/herdr-app (HERDR_APP_HOME). Walks the repo's files only,
# so live-only files (gpui-kit.d.ts, backups, built-in mods) are ignored. Exit 1 on any difference or missing file.
#   scripts/diff-live.sh          list differing / missing files
#   scripts/diff-live.sh -d       also print the diffs
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
LIVE="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
show=0; [ "${1:-}" = "-d" ] && show=1

bad=0
while IFS= read -r f; do
  case "$f" in mods/*|layouts/*|keys.json|programs.json|icons/*) ;; *) continue ;; esac
  if [ ! -f "$LIVE/$f" ]; then echo "missing live: $f"; bad=1
  elif ! cmp -s "$f" "$LIVE/$f"; then
    echo "differs:      $f"; bad=1
    [ $show = 1 ] && diff -u "$f" "$LIVE/$f" | head -40 || true
  fi
done < <(git ls-files)
[ $bad = 0 ] && echo "repo and $LIVE agree"
exit $bad
