import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, focused, layout, notify, openOverlay, panes, run, shared, setShared, spaces, theme, window } from "herdr";
import { describeRemote } from "./platform.js";

const TABS = [
  ["changes", "Changes", "mods/changes/changes.svg"],
  ["graph", "Graph", "mods/tabs-plus/graph.svg"],
  ["prs", "PRs", "mods/git-remote/icons/pr-open.svg"],
  ["issues", "Issues", "mods/git-remote/icons/issue-open.svg"],
  ["actions", "CI", "mods/git-remote/icons/actions.svg"],
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

// Where the Git panel's repo is: the focused terminal's folder, on its machine
// (the same rule the Changes panel uses).
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

export function selectGitTab(id) {
  setShared("git.subtab", id);
  if (id === "changes" || id === "graph") {
    setShared("git.focus", { target: id, at: Date.now() });
    run("layout.select", { stack: "git-body", child: id });
  } else {
    setShared("git-remote.tab", id);
    setShared("git.focus", { target: "git-remote", at: Date.now() });
    run("layout.select", { stack: "git-body", child: "git-remote" });
  }
}

export default class GitHubSwitcher extends View {
  init(_props, cx) {
    this.sync = null;
    this.busy = false;
    this.context = null;
    this.refreshSync(cx);
    // Ahead/behind come from the last fetch (read-only, no network); keep them current.
    cx.timer.every(10000, (cx) => { if (window()?.active) this.refreshSync(cx); });
  }

  refreshSync(cx) {
    if (this.busy || this.reading) return;
    const { cwd, on } = location();
    const context = JSON.stringify([cwd, on]);
    if (context !== this.context) { this.context = context; this.sync = null; }
    if (!cwd) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", ["--no-optional-locks", ...args], { cwd, on });
        const top = await git(["rev-parse", "--show-toplevel"]);
        if (top.code !== 0) { if (this.context === context) this.sync = { repo: false }; return; }
        const root = top.stdout.trim();
        const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        const origin = await git(["remote", "get-url", "origin"]);
        const remote = origin.code === 0 ? describeRemote(origin.stdout) : null;
        const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
        let ahead = 0, behind = 0;
        if (up.code === 0) {
          const c = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
          if (c.code === 0) [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
        }
        if (this.context === context) {
          this.sync = { repo: true, root, branch, remote, upstream: up.code === 0 ? up.stdout.trim() : null, ahead, behind, on };
        }
      } catch { if (this.context === context) this.sync = null; }
      finally { this.reading = false; cx.notify(); }
    });
  }

  // Fast-forward only: never creates a merge commit or rewrites local work.
  pull(cx) {
    const s = this.sync;
    if (!s?.repo || !s.upstream || this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let title = "", body = "", level = "info";
      try {
        const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: s.root, on: s.on })).stdout.trim();
        const r = await exec("git", ["pull", "--ff-only"], { cwd: s.root, on: s.on });
        if (r.code !== 0) {
          const why = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).slice(-2).join(" ");
          title = `拉取失敗 · ${s.branch}`; body = why.slice(0, 160); level = "error";
        } else {
          const after = (await exec("git", ["rev-parse", "HEAD"], { cwd: s.root, on: s.on })).stdout.trim();
          if (before === after) { title = `已是最新 · ${s.branch}`; level = "success"; }
          else {
            const n = (await exec("git", ["rev-list", "--count", `${before}..${after}`], { cwd: s.root, on: s.on })).stdout.trim();
            title = `已拉取 ${n} 個 commit · ${s.branch}`; level = "success";
            setShared("git-remote.changed", { at: Date.now() });
          }
        }
      } catch (e) { title = "拉取失敗"; body = String(e).slice(0, 160); level = "error"; }
      notify({ title, body, level, timeout: level === "error" ? 8000 : 4000 });
      this.busy = false;
      this.reading = false;
      this.refreshSync(cx);
      cx.notify();
    });
  }

  syncRow(t) {
    const s = this.sync;
    const label = (text, color) => div().text_size(12).font_semibold().text_color(color).child(text);
    let info;
    if (!s) info = div().text_size(12).text_color(t.dim).child("讀取中…");
    else if (!s.repo) info = div().text_size(12).text_color(t.dim).child("不在 Git 專案內");
    else {
      info = h_flex().gap(8).items_center().flex_1().min_w(0)
        .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().text_size(12.5).font_semibold().child(s.branch))
        .when(Boolean(s.remote), (e) => {
          const c = s.remote.color ?? t.muted;
          return e.child(div().flex_none().h(18).px(6).flex().items_center().rounded(4).border_1().border_color(`${c}66`)
            .text_size(10.5).text_color(c).tooltip(`origin：${s.remote.host}/${s.remote.slug}`).child(s.remote.label));
        })
        .when(!s.upstream, (e) => e.child(div().text_size(11).text_color(t.dim).child("無上游分支")))
        .when(s.behind > 0, (e) => e.child(label(`↓${s.behind}`, t.warning ?? t.working)))
        .when(s.ahead > 0, (e) => e.child(label(`↑${s.ahead}`, t.accent)))
        .when(s.upstream && s.behind === 0 && s.ahead === 0, (e) => e.child(div().text_size(11).text_color(t.dim).child("已同步")));
    }
    const can = Boolean(s?.repo && s.upstream) && !this.busy;
    const needs = can && s.behind > 0;
    return h_flex().h(32).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).child(info))
      .child(div().id("git-review").h(24).px(10).flex_none().flex().items_center().rounded(6)
        .border_1().border_color(t.border).bg(t.surface)
        .text_size(12).font_semibold().text_color(s?.repo ? t.foreground : t.dim)
        .when(Boolean(s?.repo), (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)))
        .tooltip("審查目前的變更：未提交、最後一個 commit、對 base；可留言送給 agent、也能提交")
        .on_click(() => { if (s?.repo) openOverlay({ mod: "review", kind: "dialog", width: 0.88, height: 0.92, props: { root: s.root, on: s.on } }); })
        .child(svg("mods/git-hub/icons/eye.svg").size(14).flex_none().text_color(s?.repo ? t.foreground : t.dim)))
      .child(div().id("git-pull").h(24).px(10).flex_none().flex().items_center().rounded(6)
        .border_1().border_color(needs ? t.accent : t.border)
        .bg(needs ? t.selected : t.surface)
        .text_size(12).font_semibold().text_color(can ? t.foreground : t.dim)
        .when(can, (e) => e.cursor_pointer().hover((x) => x.bg(t.hover)))
        .tooltip(this.busy ? "拉取中…" : "拉取（git pull --ff-only）：只做快轉，不會產生 merge commit")
        .on_click((_e, cx) => this.pull(cx))
        .child(this.busy ? svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.muted).spin(900) : svg("mods/git-hub/icons/arrow-down.svg").size(14).flex_none().text_color(can ? t.foreground : t.dim)));
  }

  render(cx) {
    const t = theme();
    // A different focused folder means a different repo: re-read right away.
    const { cwd, on } = location();
    if (JSON.stringify([cwd, on]) !== this.context) this.refreshSync(cx);
    const body = find(layout(), "git-body");
    const stackActive = body?.active ?? "changes";
    const ghTab = shared("git-remote.tab") ?? "prs";
    const active = stackActive === "git-remote" ? (["prs", "issues", "actions"].includes(ghTab) ? ghTab : "prs") : stackActive;

    return v_flex().id("git-switcher").size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(8).gap(3).items_center().border_b(1).border_color(t.border)
        .children(TABS.map(([id, label, icon]) => {
          const on = active === id;
          return h_flex().id(`git-sub-${id}`).h(28).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
            .bg(on ? t.selected : "#00000000").hover((s) => s.bg(on ? t.selected : t.hover))
            .text_size(12.5).text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold())
            .on_click(() => selectGitTab(id))
            .child(svg(icon).size(13.5).flex_none().text_color(on ? t.accent : t.muted))
            .child(label);
        })))
      .child(this.syncRow(t));
  }
}
