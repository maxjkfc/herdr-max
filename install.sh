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

# omp's own icon (from can1357/oh-my-pi, MIT). programs.json is user-owned: only seed it when absent.
mkdir -p "$APP_HOME/icons"
cp "$REPO_DIR/icons/omp.svg" "$APP_HOME/icons/omp.svg"
if [ -f "$APP_HOME/programs.json" ]; then
  echo "programs.json exists; merge the \"omp\" entry from $REPO_DIR/programs.json by hand if you want omp's icon."
else
  cp "$REPO_DIR/programs.json" "$APP_HOME/programs.json"
fi

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
