#!/usr/bin/env bash
set -euo pipefail

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing herdr-max into $APP_HOME ..."
mkdir -p "$APP_HOME/layouts" "$APP_HOME/mods"

cp "$REPO_DIR/layouts/main-custom.json" "$APP_HOME/layouts/main-custom.json"

for mod_dir in "$REPO_DIR"/mods/*/; do
  mod_name="$(basename "$mod_dir")"
  mkdir -p "$APP_HOME/mods/$mod_name"
  cp -R "$mod_dir"* "$APP_HOME/mods/$mod_name/"
done

chmod +x "$APP_HOME/mods/worktree-plus/wt-helper.py" "$APP_HOME/mods/status-quota/fetch-quota.py" 2>/dev/null || true

if [ -f "$APP_HOME/keys.json" ]; then
  cp "$APP_HOME/keys.json" "$APP_HOME/keys.json.bak"
  echo "Backed up existing keys.json to $APP_HOME/keys.json.bak"
fi
cp "$REPO_DIR/keys.json" "$APP_HOME/keys.json"

if command -v herdr-app >/dev/null 2>&1; then
  for mod_dir in "$REPO_DIR"/mods/*/; do
    mod_name="$(basename "$mod_dir")"
    herdr-app check "$APP_HOME/mods/$mod_name" || true
  done
  herdr-app do layout.switch --name main-custom >/dev/null 2>&1 || true
fi

echo "Done! Switched layout to main-custom (press Ctrl+Shift+L in Herdr to toggle layouts)."
