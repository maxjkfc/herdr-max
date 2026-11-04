# herdr-max

A customized [Herdr](https://herdr.dev) desktop layout (`main-custom`) and mod suite designed for multi-repo workspaces, issue-driven Git worktrees, TUI-style `Ctrl+A` prefix navigation, multi-account AI quota tracking, and lightweight system telemetry.

![herdr-max preview](preview.svg)

---

## Features / 核心功能

### 1. `spaces-plus` — Unified Spaces & Worktrees Tree with Live Agent & Issue Badges
- **Automatic Worktree Nesting**: Nests linked Git worktrees (`~/.herdr/worktrees/<repo>/<branch>`) directly under their parent Space—supporting both single-repo Spaces and multi-repo umbrella folders.
- **Live Agent Status Pill**: Shows which coding agent (`omp`, `claude`, `codex`, etc.) is active inside each Space/Worktree and its real-time status (`working`, `blocked`, `done`, `idle`).
- **Dynamic Issue Binding**: Displays the currently bound GitHub Issue (`🎯 #235 ...`) on a second line under each Worktree. Click the badge (or press `Ctrl+A` → `i`) at any time to switch or rebind the Issue as your work evolves.
- **Zero-Friction Worktree Auto-Cleanup**: When you close a Worktree Space (`Cmd+W`, `Ctrl+A` → `x`, or `exit`), clean worktrees are automatically removed in the background (`git worktree remove` + `git branch -d`). If uncommitted files or unpushed commits exist, a safety dialog prompts before anything is deleted.

### 2. `worktree-plus` — Multi-Repo & GitHub Issue Worktree Manager (`Ctrl+A` → `G`)
- **Umbrella Workspace Support**: If your current Space is a parent folder containing multiple Git repositories, Step 1 lets you pick which sub-repository to branch from.
- **3 Branch Creation Modes**:
  1. **Timestamp (`omp` style)**: `wt/YYYYMMDD-HHMMSS` (press `Enter` immediately without typing).
  2. **GitHub Open Issues**: Fetches open issues via `gh issue list` (automatically honoring `.envrc` / `direnv` per repo) and generates `feat/issue-<N>-<slug>` or `fix/issue-<N>-<slug>`.
  3. **Custom Branch Name**: Type any branch name directly.
- **Switch / Rebind Issue Mode (`Ctrl+A` → `i`)**: Re-assign any open Worktree or Space to a different GitHub Issue or custom task note on the fly.

### 3. `status-quota` — Adaptive Bottom-Left Multi-Account Quota Panel (`Ctrl+A` → `u`)
- **Real-Time Multi-Account Quotas**: Reads **Claude** (OAuth 5h/7d), **Codex** (5h/7d + credit balance), and **multiple Google Gemini / Antigravity accounts** (`5h`, `7d`, `Argon`) from `~/.omp/agent/agent.db` and local credentials.
- **Spacious Two-Tier Cards**: Separates provider/account headers from per-window progress bars so account names and percentages never truncate.
- **3-Way Height Control**:
  - Auto-resizes (`layout.resize`) to fit all active provider cards without clipping.
  - Mouse-draggable top divider inside the sidebar.
  - Click the `▾ Quotas` header to collapse/expand (`28px` folded rail).
- **Detail Drawer**: Click any card or press `Ctrl+A` → `u` to open the full countdown popup with exact reset timestamps.

### 4. `workspace-status-plus` — Bottom Bar with macOS CPU / RAM / SSD Telemetry
- Displays live `CPU %`, `RAM used/total GB (%)`, and `SSD free GB` on the right side of the bottom status bar.
- Polls every 8 seconds using a single ~13ms `sysctl`/`vm_stat`/`df` pipeline **only when the Herdr window is active** (`0%` background CPU).

### 5. `tmux-prefix` & `picker-copy` — Herdr TUI (`Ctrl+A`) Keybindings
- Brings Herdr TUI's `Ctrl+A` prefix workflow to Herdr App, reading bindings dynamically from `keys.json` (`mod:tmux-prefix`).
- Includes repeatable pane navigation (`h/j/k/l`), space/tab switching, side panel toggles (`f` for Files, `d` / `r` / `o` for Git Panel → Changes / Graph / Remote), and `Ctrl+J/K` / `Ctrl+N/P` list navigation across pickers.

### 6. `git-graph` — Branch / Merge Route Map in the Right Panel (`Ctrl+A` → `r`)
- Draws the commit graph (lanes, merge curves, merge rings) of the repo under the focused pane, newest first (latest 500 commits).
- Ref chips per commit: `HEAD`/current branch, local branches, `origin/*` remotes, tags.
- Header toggle switches between **All branches** (local + remote + tags) and **HEAD only**; `↻` forces a refresh. The graph also auto-refreshes every 6s when refs change.
- Click a commit to open its detail drawer: hash, author, date, message body, changed files (first-parent diff for merges).
- Lives inside the unified **Git** right-hand panel (`Changes` | `Graph` | `Remote`). The tab bar (`tabs-plus`) keeps a clean 2-button layout: **Files** and **Git**.

### 7. `git-hub` & `github` — Unified Git Panel (`Changes | Graph | Remote`) & Issue-to-Worktree (`Ctrl+A` → `o`)
- Consolidates local working-tree diff (`Changes`), branch route map (`Graph`), and remote forge (`Remote`: Issues, PRs, Actions CI, Milestones, Projects, Repo overview) under a single **Git** button in the top-right tab bar (`mods/git-hub` switcher + `mods/github`).
- **88% × 92% PR & Issue Dialog**:
  - **Conversation & Timeline**: Markdown with inline images, comments, review verdicts, labels, assignees, and close/reopen/comment composer.
  - **Files Changed (Diff) Tab**: Full two-column file list (`+`/`−` counts) + virtualized unified diff viewer inside the PR dialog.
  - **Direct PR Merge**: Embedded in `mergeBox` with **Merge commit / Squash and merge / Rebase and merge** confirmation and `--match-head-commit` SHA guard.
- **1-Click Issue → Herdr Worktree (`spaces-plus` + `worktree-plus` integration)**:
  - Click the branch icon on any hovered Issue row, or click **Open Worktree** inside the Issue dialog, to automatically create `~/.herdr/worktrees/<repo>/feat/issue-<N>-<slug>`, bind `🎯 #<N>` in `shared("worktree-plus.meta")`, and switch to the new nested Worktree Space.
  - **Start agent** on an Issue includes a `🌱 在新 Worktree 啟動并綁定 Issue` toggle so the coding agent launches directly inside the isolated Issue Worktree with the full issue brief.

---

## Keybindings (`Ctrl+A` Prefix & Global)

| Key | Action | Description |
|---|---|---|
| `Ctrl+A` → `h / j / k / l` | `pane.go` | Move focus left / down / up / right (repeatable within 500ms) |
| `Ctrl+A` → `v` or `\` | `pane.split:right` | Split pane right |
| `Ctrl+A` → `-` | `pane.split:down` | Split pane down |
| `Ctrl+A` → `G` (`Shift+G`) | `worktree-plus` | Create Git Worktree (Timestamp / GitHub Issue / Custom) |
| `Ctrl+A` → `i` | `worktree-issue` | Bind or switch the current Worktree's GitHub Issue |
| `Ctrl+A` → `u` | `status-quota` | Open AI Quota & Reset Countdown drawer |
| `Ctrl+A` → `f` | `files` | Toggle right-hand Files panel |
| `Ctrl+A` → `d` | `changes` | Toggle right-hand Git panel → **Changes** (diff & commit) |
| `Ctrl+A` → `r` | `graph` | Toggle right-hand Git panel → **Graph** (branch route map) |
| `Ctrl+A` → `o` | `github` | Toggle right-hand Git panel → **Remote** (Issues / PRs / Actions) |
| `Ctrl+A` → `g` / `w` | `picker-copy` | Open Goto Picker (with empty spaces expanded & `Ctrl+J/K` support) |
| `Ctrl+A` → `m` | `new-menu` | Open New Agent / Tab menu |
| `Ctrl+A` → `c` / `n` / `p` | `tab.*` | New tab / Next tab / Previous tab |
| `Ctrl+A` → `J` / `K` (`Shift+J/K`) | `space.next` / `prev` | Next / Previous Space |
| `Ctrl+Shift+L` | `layout.switch` | Toggle between `main-custom` and Herdr's default `main` layout |

---

## Installation

### Option 1: One-Line Script
```bash
git clone https://github.com/maxjkfc/herdr-max.git ~/code/herdr-max
~/code/herdr-max/install.sh
```

### Option 2: Ask Your Agent in Herdr
Paste into any agent running inside Herdr:
> Read `https://github.com/maxjkfc/herdr-max` (`RECIPE.md`) and install the `main-custom` layout and mods into `~/.config/herdr-app`.

---

## Rollback / Uninstall
`herdr-max` never overwrites Herdr's built-in `layouts/main.json` or built-in mods (`spaces`, `worktree`, `workspace-status`, `picker`).
- Press **`Ctrl+Shift+L`** at any time to switch back to the default `main` layout.
- Your previous `keys.json` is backed up to `~/.config/herdr-app/keys.json.bak`.

## License
Apache-2.0
