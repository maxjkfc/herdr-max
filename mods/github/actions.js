import { v_flex, h_flex } from "gpui-base";
import { div, svg, image } from "gpui-kit";
import { run, notify, openOverlay, closeOverlay, knownAgents, spaces, panes, exec, home, shared, setShared, nextCommand } from "herdr";
import { glyph, under } from "./ui.js";

export function copied(cx, text, title, body) {
  cx.write_to_clipboard(text);
  notify({ title, body, level: "success", timeout: 2500 });
}

const STOP = new Set(["the", "and", "for", "with", "from", "into", "fix", "feat", "bug"]);
export function issueBranchName(num, title = "") {
  const lower = String(title).toLowerCase();
  const prefix = /\b(fix|bug|hotfix)\b|修復|修正|錯誤|失敗/.test(lower) ? "fix" : "feat";
  const words = (lower.match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).slice(0, 5);
  return words.length ? `${prefix}/issue-${num}-${words.join("-")}` : `${prefix}/issue-${num}`;
}

const wtSlug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

function resolveRepoFolder(folder, spaceId) {
  if (folder) return folder;
  const sp = spaces().find((s) => (spaceId ? s.id === spaceId : s.active)) ?? spaces().find((s) => s.active);
  if (!sp) return null;
  const tabs = new Set((sp.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp.folder || null;
}

// Creates or focuses a Herdr worktree space under ~/.herdr/worktrees/<repo>/<slug(branch)>,
// registers it in shared("worktree-plus.meta") so spaces-plus nests it and shows its 🎯 #N badge.
export async function openIssueWorktree({ issue, folder, space, argv, task }) {
  const cwd = resolveRepoFolder(folder, space);
  if (!cwd) throw new Error("No local repository checkout found for this space");
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (common.code !== 0) throw new Error("Current folder is not a git repository");
  const gdir = common.stdout.trim();
  const mainRepo = gdir.endsWith("/.git") ? gdir.slice(0, -5) : gdir;
  const repoName = mainRepo.replace(/\/+$/, "").split("/").pop();
  const branch = issue.branch || issueBranchName(issue.number, issue.title);
  const wtPath = `${home()}/.herdr/worktrees/${repoName}/${wtSlug(branch)}`;
  const cleanWt = wtPath.replace(/\/+$/, "");

  const existing = spaces().find((s) => (s.folder ?? "").replace(/\/+$/, "") === cleanWt);
  if (existing) {
    run("space.select", { id: existing.id });
    if (argv?.length) run("tab.new", { space: existing.id, folder: cleanWt, name: `#${issue.number}`, argv, task });
    notify({ title: `Switched to worktree #${issue.number}`, body: branch, level: "info", timeout: 2500 });
    return existing.id;
  }

  const ref = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: mainRepo });
  const addArgs = ref.code === 0 ? ["worktree", "add", cleanWt, branch] : ["worktree", "add", "-b", branch, cleanWt, "HEAD"];
  const add = await exec("git", addArgs, { cwd: mainRepo });
  if (add.code !== 0 && !/already checked out|already exists/i.test(add.stderr)) {
    throw new Error((add.stderr || add.stdout).trim() || "git worktree add failed");
  }

  const parentSpaceId =
    space ??
    spaces().find((s) => !s.machine && (s.folder ?? "").replace(/\/+$/, "") === mainRepo)?.id ??
    spaces().find((s) => s.active)?.id ??
    null;
  const meta = { ...(shared("worktree-plus.meta") ?? {}) };
  meta[cleanWt] = {
    parentSpaceId,
    repoTop: mainRepo,
    repoName,
    branch,
    issue: { number: issue.number, title: issue.title },
    updatedAt: Date.now(),
  };
  setShared("worktree-plus.meta", meta);

  const newArgs = { folder: cleanWt, name: branch };
  if (argv?.length) {
    newArgs.tab = `#${issue.number}`;
    newArgs.argv = argv;
    if (task) newArgs.task = task;
  }
  run("space.new", newArgs);
  notify({ title: `Worktree created for #${issue.number}`, body: `${repoName} · ${branch}`, level: "success", timeout: 3000 });
  return cleanWt;
}

// The agent menu: a popup of this mod listing the installed agents, under the button that asked.
export function pickAgent(task) {
  openOverlay({ mod: "github", kind: "popup", width: 280, height: 340, at: under(280), props: { agentMenu: task } });
}

// Starts the agent in a new tab (or a new worktree space when `inWorktree` is on and `issue` is present).
export async function launch(agent, { name, brief, folder, space, issue, inWorktree }) {
  if (inWorktree && issue) {
    await openIssueWorktree({ issue, folder, space, argv: agent.run, task: brief });
    return;
  }
  const args = { name: name.slice(0, 48), argv: agent.run, task: brief };
  const homeSpace = space ?? spaces().find((s) => !s.machine && folder && s.folder === folder)?.id ?? spaces().find((s) => s.active)?.id;
  if (homeSpace) args.space = homeSpace;
  if (folder) args.folder = folder;
  run("tab.new", args);
  notify({ title: `${agent.name} started`, body: name, level: "success", timeout: 3000 });
}

export class AgentMenu {
  constructor(task, overlay, cx) {
    this.task = task; this.overlay = overlay; this.agents = null; this.idx = 0;
    this.inWorktree = Boolean(task.issue && task.folder);
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(50, () => this.handle.focus());
    cx.spawn(async (cx) => { this.agents = (await knownAgents().catch(() => [])).filter((a) => a.installed && a.run?.length); cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        const n = (this.agents ?? []).length;
        if (!n) continue;
        if (cmd === "down") this.idx = (this.idx + 1) % n;
        else if (cmd === "up") this.idx = (this.idx + n - 1) % n;
        cx.notify();
      }
    });
  }
  pick(a, cx) {
    if (!a) return;
    cx.spawn(async () => {
      try { await launch(a, { ...this.task, inWorktree: this.inWorktree }); }
      catch (err) { notify({ title: "啟動失敗", body: String(err?.message ?? err), level: "error" }); }
    });
    closeOverlay(this.overlay);
  }
  onKey(e, cx) {
    const k = e.key, list = this.agents ?? [];
    if (k === "escape" || k === "q") { cx.stop_propagation(); closeOverlay(this.overlay); return; }
    if (k === "w" && this.task.issue && this.task.folder) { this.inWorktree = !this.inWorktree; cx.stop_propagation(); cx.notify(); return; }
    if (!list.length) return;
    if (k === "j" || k === "down" || ((k === "j" || k === "n") && e.modifiers?.control)) {
      this.idx = (this.idx + 1) % list.length; cx.stop_propagation(); cx.notify();
    } else if (k === "k" || k === "up" || ((k === "k" || k === "p") && e.modifiers?.control)) {
      this.idx = (this.idx + list.length - 1) % list.length; cx.stop_propagation(); cx.notify();
    } else if (k === "enter") {
      cx.stop_propagation(); this.pick(list[this.idx], cx);
    } else if (/^[1-9]$/.test(k) && list[Number(k) - 1]) {
      cx.stop_propagation(); this.pick(list[Number(k) - 1], cx);
    }
  }
  render(cx, t) {
    const list = this.agents, hasIssue = Boolean(this.task.issue && this.task.folder);
    return v_flex().id("agent-menu").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().px(8).pt(4).pb(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().font_semibold().truncate().child(`派發 Agent：${this.task.name}`))
        .child(div().child("j/k · Enter")))
      .when(hasIssue, (e) => e.child(h_flex().id("agent-wt-toggle").h(28).px(8).mb(4).gap(6).items_center().rounded(6).cursor_pointer()
        .bg(this.inWorktree ? t.selected : t.raised).border_1().border_color(this.inWorktree ? t.accent : t.border)
        .on_click((_e, cx) => { this.inWorktree = !this.inWorktree; cx.notify(); })
        .child(div().text_size(12).child(this.inWorktree ? "🌱 在新 Worktree 啟動並綁定 [W]" : "在目前 Space 開新 Tab 啟動 [W]"))))
      .when(!list, (e) => e.child(div().px(8).py(6).text_color(t.muted).child("正在讀取已安裝的 Agent…")))
      .when(list?.length === 0, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.muted).child("尚未設定 Agent（請在 programs.json 新增）")))
      .children((list ?? []).map((a, n) => {
        const on = this.idx === n;
        return h_flex().id(`agent-${n}`).h(32).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .bg(on ? t.selected : "#00000000").border_1().border_color(on ? t.accent : "#00000000")
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(a, cx))
          .child(div().size(16).flex_none().when(Boolean(a.icon), (e) => e.child(a.tint ? svg(a.icon).size(16).text_color(t.muted) : image(a.icon).size(16))))
          .child(div().flex_1().truncate().child(a.name))
          .child(div().text_size(11).text_color(t.dim).child(`[${n + 1}]`));
      }))
      .child(div().flex_1())
      .child(h_flex().px(8).py(6).gap(6).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(glyph("folder", 12, t.dim)).child(div().truncate().child(this.task.folder ?? "本機尚未 clone：Agent 會自行 clone")));
  }
}

// Copy link / reference / number / brief: under its button, or at the pointer for a right-click.
export function copyMenu(items, at = under(300)) {
  openOverlay({ mod: "github", kind: "popup", width: 300, height: 14 + items.length * 48, at, props: { copyMenu: items } });
}
export function renderCopyMenu(items, overlay, t) {
  return v_flex().id("copy-menu").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(12)
    .children(items.map(([label, text, preview], n) => v_flex().id(`copy-${n}`).h(46).flex_none().justify_center().px(8).rounded(6).cursor_pointer()
      .hover((e) => e.bg(t.hover))
      .on_click((_e, cx) => { copied(cx, text, "Copied", preview ?? text); closeOverlay(overlay); })
      .child(div().font_semibold().child(label))
      .child(div().text_size(11).text_color(t.muted).truncate().child(preview ?? text))));
}
