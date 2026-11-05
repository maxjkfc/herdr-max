import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, agents, focused, run, layout, theme, openOverlay, closeOverlay, notify, props, shared, setShared, nextCommand } from "herdr";
import { primer, glyph, spinner, ago, openUrl, issueState, prState, runState, checksOf, glyphOf, labelChip, button, blankslate, skeleton } from "./ui.js";
import { gh, ghJson, account, declaredUser, loginsOf, remoteOf, checkouts, load, localState, ROOTS } from "./gh.js";
import { githubSlug } from "./platform.js";
import { issueBrief, prBrief, worktreeOf } from "./brief.js";
import { Viewer } from "./viewer.js";
import { RunView } from "./run.js";
import { AgentMenu, copied, pickAgent, copyMenu, renderCopyMenu, openIssueWorktree } from "./actions.js";

const PAGE = 50, SYNC = 60000, LIVE = 10000;
const TABS = {
  prs: { label: "Pull Requests", short: "PRs", icon: "pr-open" },
  issues: { label: "Issues", short: "Issues", icon: "issue-open" },
  actions: { label: "CI Actions", short: "CI", icon: "actions" },
};
const STATES = {
  issues: [["open", "issue-open", "Open"], ["closed", "check", "Closed"]],
  prs: [["open", "pr-open", "Open"], ["merged", "pr-merged", "Merged"], ["closed", "pr-closed", "Closed"]],
};
const METHODS = [["merge", "Merge", "pr-merged"], ["squash", "Squash", "commit"], ["rebase", "Rebase", "branch"]];

const remembered = (key, fallback = {}) => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full: memory only */ } };
function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}
function hidden() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body"), gitBody = find(root, "git-body");
  if (!panel) return false;
  if (panel.hidden) return true;
  if (gitBody) return body?.active !== "git" || gitBody.active !== "git-remote";
  if (!body?.children?.some((c) => c.content?.mod === "git-remote")) return false;
  return find(body, body.active)?.content?.mod !== "git-remote";
}
function location(last) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal && last) return last;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null, space: f?.space ?? space?.id };
}

export default class GitHub extends View {
  init(_props, cx) {
    const pr = props() ?? {};
    if (pr.item) { this.viewer = new Viewer(pr.item, pr.overlay, cx); return; }
    if (pr.run) { this.runView = new RunView(pr.run, pr.overlay, cx); return; }
    if (pr.agentMenu) { this.agentMenu = new AgentMenu(pr.agentMenu, pr.overlay, cx); return; }
    if (pr.copyMenu) { this.copying = { items: pr.copyMenu, overlay: pr.overlay }; return; }
    if (pr.picker) { this.initPicker(pr.picker, pr.overlay, cx); return; }
    if (pr.accountMenu) { this.accountMenu = { ...pr.accountMenu, overlay: pr.overlay }; return; }
    if (pr.create) { this.initCreate(pr.create, pr.overlay, cx); return; }

    this.handle = cx.focus_handle();
    this.fixed = pr.repo ?? null;
    this.roots = Array.isArray(pr.roots) ? pr.roots : [];
    this.remotes = remembered("remotes"); this.pins = remembered("pins"); this.spaceRepos = remembered("spaces");
    // gh accounts: the ones gh knows, what a folder's .envrc declares, and the user's per-folder pick ("" = auto).
    this.logins = []; this.declared = {}; this.chosen = remembered("accounts"); this.accountUser = undefined;
    this.tab = shared("git-remote.tab") ?? "prs";
    this.f = remembered("filters", null) ?? { prs: { state: "open", mine: false }, issues: { state: "open", mine: false }, actions: { failing: false, branch: false } };
    this.limit = PAGE; this.data = {}; this.locals = {}; this.query = "";
    this.selectedIdx = 0; this.inlineMergeNum = null; this.mergingNum = null;
    this.input = InputState.new({ placeholder: "篩選標題、#編號、分支或作者…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.limit = PAGE; this.selectedIdx = 0; cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.changedAt = shared("git-remote.changed")?.at; this.pickedAt = shared("git-remote.pick")?.at; this.acctAt = shared("git-remote.pick-account")?.at;
    this.focusAt = shared("git.focus")?.at;
    this.sharedTab = shared("git-remote.tab");

    cx.spawn(async (cx) => {
      await this.syncUser(); cx.notify();
      this.refresh(cx);
      this.locals = await checkouts(this.roots); cx.notify();
    });
    cx.timer.every(SYNC, (cx) => { if (!hidden()) this.refresh(cx, true); });
    cx.timer.every(LIVE, (cx) => { if (!hidden() && this.shownTab() === "actions" && this.items()?.some((r) => r.status !== "completed")) this.refresh(cx, true); });

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") { this.typing = false; this.handle.focus(); }
        else if (TABS[c]) this.setTab(c, cx);
        else if (c === "down") {
          const items = this.filteredItems();
          if (items.length) this.selectedIdx = (this.selectedIdx + 1) % items.length;
        } else if (c === "up") {
          const items = this.filteredItems();
          if (items.length) this.selectedIdx = (this.selectedIdx + items.length - 1) % items.length;
        } else if (c === "refresh") this.refresh(cx);
        else if (c === "open") this.openFirst();
        else if (c === "switch" && !this.fixed) this.openPicker();
        else if (c === "all" || c === "follow") this.setPin(this.where().space, c === "all" ? "all" : null, cx);
        cx.notify();
      }
    });
  }

  where() { return (this.here ??= (this.last = location(this.last))); }
  pin() { return this.fixed ?? this.pins[this.where().space] ?? null; }
  all() { return this.pin() === "all"; }
  repo() {
    const pin = this.pin();
    if (pin && pin !== "all") return pin;
    return this.spaceRepos[this.where().space] ?? null;
  }
  owners() { return this.account?.state === "ready" ? [this.account.login, ...this.account.orgs] : []; }
  scope() { return this.all() ? { owners: this.owners() } : this.repo() ? { repo: this.repo() } : null; }
  scopeKey() { return this.all() ? "all" : this.repo(); }
  shownTab() { return TABS[this.tab] ? this.tab : "prs"; }
  filters(tab = this.shownTab()) {
    const f = { ...(this.f[tab] ?? {}) };
    if (tab === "actions") f.branch = f.branch ? this.locals[this.repo()]?.branch ?? null : null;
    return f;
  }
  key(tab = this.shownTab(), f = this.filters(tab)) { return `${shared("git-remote.user") ?? ""}|${this.scopeKey()}|${tab}|${JSON.stringify(f)}`; }
  entry(key = this.key()) { return (this.data[key] ??= { items: remembered(`d:${key}`, null), at: 0 }); }
  items() { return this.entry().items; }

  // The picked account for a folder: the longest picked folder above it; null when none, or the pick is "auto".
  chosenUser(cwd) {
    let best = null;
    for (const dir of Object.keys(this.chosen)) if ((cwd === dir || cwd.startsWith(`${dir}/`)) && (!best || dir.length > best.length)) best = dir;
    return best ? this.chosen[best] || null : null;
  }

  // Act as the gh account the focused folder wants: the pick, else its .envrc, else gh's active one, resolved to a
  // name each time so the chip, the cache keys and the gh calls agree even when something flips gh's active account.
  // Reload who that is when it changed. On another machine nothing changes: its gh is its own.
  async syncUser() {
    const { cwd, on } = this.where();
    if (cwd && !on) {
      if (!(cwd in this.declared)) this.declared[cwd] = await declaredUser(cwd);
      this.logins = await loginsOf();
      const user = this.chosenUser(cwd) ?? this.declared[cwd] ?? this.logins.find((l) => l.active)?.login ?? null;
      if ((shared("git-remote.user") ?? null) !== user) setShared("git-remote.user", user);
    }
    const want = shared("git-remote.user") ?? null;
    if (!this.account || this.accountUser !== want) { this.accountUser = want; this.account = await account(); }
  }

  // Remember the account chosen for a folder ("" = auto) and reload as it.
  chooseUser(dir, user, cx) {
    this.chosen[dir] = user;
    keep("accounts", this.chosen);
    cx.spawn(async (cx) => { await this.syncUser(); this.refresh(cx); cx.notify(); });
  }

  // The account dropdown: a popup listing "auto" and every logged-in account, the current pick ticked.
  openAccountMenu() {
    const { cwd, space } = this.where();
    if (!cwd) return;
    const dir = spaces().find((s) => s.id === space)?.folder ?? cwd;
    openOverlay({ mod: "git-remote", kind: "popup", width: 280, height: 64 + (this.logins.length + 1) * 46, at: "pointer",
      props: { accountMenu: { dir, picked: this.chosenUser(cwd) ?? "", declared: this.declared[cwd] ?? null, logins: this.logins } } });
  }

  async follow() {
    await this.syncUser();
    const { cwd, on, space } = this.where();
    if (!cwd || on) return;
    const id = JSON.stringify([cwd, on]);
    if (!(id in this.remotes)) { this.remotes[id] = await remoteOf(cwd, on); keep("remotes", this.remotes); }
    const found = githubSlug(this.remotes[id]);
    if ((this.spaceRepos[space] ?? null) !== found) { this.spaceRepos[space] = found; keep("spaces", this.spaceRepos); }
  }

  // The platform of the focused folder's origin when it is not one this panel can show (GitLab, Bitbucket, …).
  foreign() {
    const { cwd, on } = this.where();
    const r = cwd && !on ? this.remotes[JSON.stringify([cwd, on])] : null;
    return r && !githubSlug(r) ? r : null;
  }

  refresh(cx, quiet = false) {
    cx.spawn(async (cx) => {
      await this.follow();
      // The origin's platform is shown even when gh can't serve it (not installed, signed out).
      if (this.account?.state !== "ready") return cx.notify();
      const scope = this.scope();
      if (!scope) return cx.notify();
      const tab = this.shownTab(), key = this.key(tab), e = this.entry(key);
      if (e.loading) return;
      e.loading = true; if (!quiet) e.error = null; cx.notify();
      try {
        if (tab === "actions" && this.f.actions?.branch && scope.repo) await this.readLocal(scope.repo);
        const f = this.filters(tab), real = this.key(tab, f), got = await load[tab](scope, f);
        this.data[real] = { items: got, at: Date.now() };
        keep(`d:${real}`, got);
      } catch (err) { e.error = String(err?.message ?? err); }
      finally { e.loading = false; cx.notify(); }
    });
  }

  async readLocal(repo) {
    const l = this.locals[repo];
    if (l?.folder) Object.assign(l, await localState(l.folder));
  }

  setTab(tab, cx) {
    this.tab = tab; this.limit = PAGE; this.selectedIdx = 0; this.inlineMergeNum = null;
    setShared("git-remote.tab", tab); setShared("git.subtab", tab);
    this.refresh(cx); cx.notify();
  }
  setFilter(tab, patch, cx) {
    this.limit = PAGE; this.selectedIdx = 0; this.inlineMergeNum = null;
    this.f[tab] = { ...this.f[tab], ...patch }; keep("filters", this.f);
    this.refresh(cx); cx.notify();
  }
  setPin(space, value, cx) {
    if (value) this.pins[space] = value; else delete this.pins[space];
    keep("pins", this.pins); this.refresh(cx); cx.notify();
  }

  // ---- opening & actions ----
  localFor(repo) { const l = this.locals[repo]; return l ? { [repo]: { folder: l.folder, space: l.space ?? null } } : {}; }
  open(item, kind) {
    openOverlay({
      mod: "git-remote",
      kind: "dialog",
      width: 0.88,
      height: 0.92,
      props: { item: { kind, repo: item.repo, number: item.number, me: this.account?.login, locals: this.localFor(item.repo), data: kind === "pr" ? null : item.body !== undefined ? item : null } },
    });
  }
  openRun(r) {
    const l = this.locals[r.repo];
    openOverlay({ mod: "git-remote", kind: "dialog", width: 0.8, height: 0.88, props: { run: { run: r, local: l ? { folder: l.folder, space: l.space ?? null } : null } } });
  }
  async brief(item, kind) {
    const fields = kind === "pr"
      ? "number,title,body,author,state,labels,assignees,comments,url,headRefName,baseRefName,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,reviews,closingIssuesReferences,milestone,isCrossRepository"
      : "number,title,body,author,state,labels,assignees,comments,url,milestone";
    const full = { ...await ghJson([kind === "pr" ? "pr" : "issue", "view", String(item.number), "-R", item.repo, "--json", fields]), repo: item.repo };
    if (kind === "pr") full.checks = checksOf(full);
    const l = this.locals[item.repo], local = l ? { ...l, ...(await localState(l.folder) ?? {}) } : null;
    // A PR's agent works where its branch is already checked out, if some worktree of the clone has it.
    const folder = kind === "pr" ? worktreeOf(local, full)?.path ?? null : null;
    return { text: kind === "pr" ? prBrief(full, { local }) : issueBrief(full, { local }), folder };
  }
  startAgent(item, kind, cx) {
    cx.spawn(async () => {
      try {
        const l = this.locals[item.repo];
        const { text, folder } = await this.brief(item, kind);
        pickAgent({
          name: `${kind === "pr" ? "PR " : ""}#${item.number} ${item.repo.split("/")[1]}`,
          brief: text,
          folder: folder ?? l?.folder ?? null,
          space: l?.space ?? null,
          issue: kind === "issue" ? { number: item.number, title: item.title } : null,
        });
      } catch (e) { notify({ title: "準備 Brief 失敗", body: String(e?.message ?? e), level: "error" }); }
    });
  }
  openWorktree(item) {
    const l = this.locals[item.repo];
    openIssueWorktree({ issue: { number: item.number, title: item.title }, folder: l?.folder ?? null, space: l?.space ?? null })
      .catch((e) => notify({ title: "Worktree 建立失敗", body: String(e?.message ?? e), level: "error" }));
  }
  inlineMerge(item, method, cx) {
    if (this.mergingNum) return;
    this.mergingNum = item.number;
    cx.spawn(async (cx) => {
      try {
        const args = ["pr", "merge", String(item.number), "-R", item.repo, `--${method}`];
        if (item.headRefOid) args.push("--match-head-commit", item.headRefOid);
        await gh(args);
        notify({ title: `PR #${item.number} 已合併`, body: item.title, level: "success", timeout: 3000 });
        this.inlineMergeNum = null;
        this.refresh(cx);
      } catch (e) {
        notify({ title: `合併 #${item.number} 失敗`, body: String(e?.message ?? e), level: "error" });
      } finally {
        this.mergingNum = null; cx.notify();
      }
    });
    cx.notify();
  }
  openFirst() {
    const tab = this.shownTab(), items = this.filteredItems(tab);
    if (tab === "actions") return items[0] && this.openRun(items[0]);
    if (items[0]) this.open(items[0], tab === "prs" ? "pr" : "issue");
  }
  copyItem(item) {
    copyMenu([["複製連結", item.url], ["複製編號引用", `${item.repo}#${item.number}`], ["複製標題", `#${item.number} ${item.title}`]], "pointer");
  }

  // Find if an Issue already has a linked Worktree Space open in spaces-plus.
  boundWorktreeForIssue(repo, number) {
    const repoShort = (repo ?? "").split("/")[1]?.toLowerCase();
    const meta = shared("worktree-plus.meta") ?? {};
    const allSpaces = spaces();
    const allAgents = agents();
    for (const [k, v] of Object.entries(meta)) {
      if (v?.issue?.number === number && (!repoShort || (v.repoName ?? "").toLowerCase() === repoShort)) {
        const sp = k.startsWith("space:")
          ? allSpaces.find((s) => s.id === k.slice(6))
          : allSpaces.find((s) => (s.folder ?? "").replace(/\/+$/, "") === k);
        if (sp) {
          const ag = allAgents.find((a) => a.space === sp.id);
          return { space: sp, branch: v.branch, agent: ag ? { name: ag.app || "agent", status: ag.status } : null };
        }
      }
    }
    return null;
  }

  matches(text) { const q = this.query.trim().toLowerCase(); return !q || text.toLowerCase().includes(q); }

  filteredItems(tab = this.shownTab()) {
    const items = this.entry()?.items ?? [];
    if (tab === "actions") return items.filter((r) => this.matches(`${r.displayTitle} ${r.workflowName} ${r.headBranch} #${r.number}`));
    return items.filter((i) => this.matches(`#${i.number} ${i.title} ${i.repo} ${i.author?.login ?? ""} ${i.headRefName ?? ""} ${(i.labels ?? []).map((l) => l.name).join(" ")}`));
  }

  // ---- Card-based rows (herdr-max style) ----
  prCard(item, idx, t, cx) {
    const p = primer(t), [g, color, stateLabel] = prState(item, p), checks = item.statusCheckRollup ? checksOf(item) : null;
    const isOpen = String(item.state).toUpperCase() === "OPEN";
    const conflict = item.mergeable === "CONFLICTING";
    const blocked = !isOpen || item.isDraft || conflict || !item.headRefOid || checks?.state === "failure" || checks?.state === "pending";
    const mergeExpanded = this.inlineMergeNum === item.number;
    const selected = this.selectedIdx === idx;

    return v_flex().id(`pr-card-${item.repo}-${item.number}`).flex_none().mx(10).my(4).p(12).gap(8).rounded(8)
      .bg(t.surface).border_1().border_color(selected ? t.accent : t.border)
      .cursor_pointer().hover((s) => s.border_color(t.accent))
      .on_click(() => { this.selectedIdx = idx; this.open(item, "pr"); })
      .on_mouse_down("right", () => this.copyItem(item))
      // Row 1: State icon + #number + Title + Check dot
      .child(h_flex().gap(7).items_start()
        .child(div().pt(2).child(glyph(g, 15, color)))
        .child(div().flex_none().font_semibold().text_size(13.5).text_color(t.muted).child(`#${item.number}`))
        .child(div().flex_1().min_w(0).font_semibold().text_size(14).text_color(t.foreground).child(item.title))
        .when(Boolean(checks?.state), (e) => e.child(div().pt(2).child(glyphOf(checks.state === "failure" ? "x-circle" : checks.state === "pending" ? "spin" : "check-circle", 14, checks.state === "failure" ? p.closed : checks.state === "pending" ? p.attention : p.open, t)))))
      // Row 2: Branch pill + +add/-del + conflict/draft badge + time
      .child(h_flex().gap(6).flex_wrap().items_center().text_size(12).text_color(t.muted)
        .when(Boolean(item.headRefName), (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(`${p.link}55`).bg(`${p.link}16`).text_color(p.link).font_family("JetBrains Mono").text_size(11.5).max_w(190).truncate().child(`${item.headRefName} → ${item.baseRefName}`)))
        .when(item.additions !== undefined, (e) => e.child(div().text_color(p.open).child(`+${item.additions}`)).child(div().text_color(p.closed).child(`−${item.deletions}`)))
        .when(conflict, (e) => e.child(div().px(5).rounded(4).border_1().border_color(`${p.closed}88`).text_color(p.closed).text_size(11).child("Conflicts")))
        .when(item.isDraft, (e) => e.child(div().px(5).rounded(4).border_1().border_color(t.border).text_color(t.muted).text_size(11).child("Draft")))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.dim).child(ago(item.updatedAt))))
      // Row 3: Always-visible action pills
      .child(h_flex().gap(6).pt(2).items_center()
        .child(button(`pr-diff-${item.number}`, `⇄ Diff${item.changedFiles ? ` (${item.changedFiles})` : ""}`, t, (_e, cx) => { cx.stop_propagation(); this.open(item, "pr"); }, { small: true }))
        .when(isOpen, (e) => e.child(button(`pr-m-btn-${item.number}`, mergeExpanded ? "Cancel" : "⑂ Merge…", t, (_e, cx) => {
          cx.stop_propagation();
          this.inlineMergeNum = mergeExpanded ? null : item.number;
          cx.notify();
        }, { small: true, primary: !mergeExpanded, color: p.open, enabled: !blocked })))
        .when(!isOpen, (e) => e.child(div().text_size(11.5).text_color(color).child(stateLabel)))
        .child(div().flex_1())
        .child(button(`pr-ag-${item.number}`, "Agent", t, (_e, cx) => { cx.stop_propagation(); this.startAgent(item, "pr", cx); }, { small: true, invisible: true, icon: "agent" })))
      // Inline 1-click Merge Method strip when expanded
      .when(mergeExpanded && !blocked, (e) => e.child(h_flex().pt(4).gap(6).items_center().border_t(1).border_color(t.border)
        .children(METHODS.map(([m, label, ic]) => button(`pr-im-${item.number}-${m}`, label, t, (_e, cx) => {
          cx.stop_propagation();
          this.inlineMerge(item, m, cx);
        }, {
          small: true,
          primary: m === "merge",
          color: m === "merge" ? p.open : m === "squash" ? p.done : p.link,
          icon: ic,
          enabled: this.mergingNum !== item.number,
        })))));
  }

  issueCard(item, idx, t, cx) {
    const p = primer(t), [g, color] = issueState(item, p);
    const bound = this.boundWorktreeForIssue(item.repo, item.number);
    const selected = this.selectedIdx === idx;

    return v_flex().id(`iss-card-${item.repo}-${item.number}`).flex_none().mx(10).my(4).p(12).gap(8).rounded(8)
      .bg(t.surface).border_1().border_color(selected ? t.accent : bound ? `${p.link}77` : t.border)
      .cursor_pointer().hover((s) => s.border_color(t.accent))
      .on_click(() => { this.selectedIdx = idx; this.open(item, "issue"); })
      .on_mouse_down("right", () => this.copyItem(item))
      // Row 1: Icon + #number + Title
      .child(h_flex().gap(7).items_start()
        .child(div().pt(2).child(glyph(g, 15, color)))
        .child(div().flex_none().font_semibold().text_size(13.5).text_color(t.muted).child(`#${item.number}`))
        .child(div().flex_1().min_w(0).font_semibold().text_size(14).text_color(t.foreground).child(item.title)))
      // Row 2: Bound Worktree status pill (if active in spaces-plus) + labels + age
      .when(Boolean(bound), (e) => e.child(h_flex().gap(6).items_center().px(7).py(3).rounded(5).bg(`${p.link}18`).border_1().border_color(`${p.link}55`).text_size(11.5).text_color(p.link)
        .child(div().truncate().child(`🎯 已綁定 Worktree：${bound.branch || bound.space.name}`))
        .when(Boolean(bound.agent), (x) => x.child(div().flex_none().text_color(t[bound.agent.status] ?? t.muted).child(`· ${bound.agent.name} (${bound.agent.status})`)))))
      .when(item.labels?.length > 0, (e) => e.child(h_flex().gap(5).flex_wrap().items_center().children(item.labels.slice(0, 4).map((l) => labelChip(l, t, true)))))
      // Row 3: Direct Worktree & Agent action pills
      .child(h_flex().gap(6).pt(2).items_center()
        .child(button(`iss-wt-${item.number}`, bound ? "🌱 Go to Worktree" : "🌱 New Worktree", t, (_e, cx) => {
          cx.stop_propagation();
          if (bound) run("space.select", { id: bound.space.id });
          else this.openWorktree(item);
        }, { small: true, primary: true, color: p.link }))
        .child(button(`iss-ag-${item.number}`, "Agent", t, (_e, cx) => {
          cx.stop_propagation();
          this.startAgent(item, "issue", cx);
        }, { small: true, color: p.open, icon: "agent" }))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.dim).child(ago(item.updatedAt))));
  }

  runCard(r, idx, t) {
    const p = primer(t), [g, color] = runState(r, p), failed = /failure|timed_out/.test(r.conclusion ?? "");
    const selected = this.selectedIdx === idx;
    return v_flex().id(`run-card-${r.databaseId}`).flex_none().mx(10).my(4).p(12).gap(6).rounded(8)
      .bg(t.surface).border_1().border_color(selected ? t.accent : failed ? `${p.closed}66` : t.border)
      .cursor_pointer().hover((s) => s.border_color(t.accent))
      .on_click(() => { this.selectedIdx = idx; this.openRun(r); })
      .child(h_flex().gap(8).items_start()
        .child(div().pt(2).child(glyphOf(g, 15, color, t)))
        .child(div().flex_1().min_w(0).font_semibold().text_size(14).child(r.displayTitle))
        .when(failed, (e) => e.child(button(`rerun-${r.databaseId}`, "↻ Re-run", t, (_e, cx) => {
          cx.stop_propagation();
          cx.spawn(async (cx) => {
            try { await gh(["run", "rerun", String(r.databaseId), "-R", r.repo, "--failed"]); notify({ title: "已觸發重新執行", body: r.workflowName, level: "success" }); this.refresh(cx); }
            catch (err) { notify({ title: "重跑失敗", body: String(err.message), level: "error" }); }
          });
        }, { small: true, color: p.closed }))))
      .child(h_flex().gap(6).flex_wrap().items_center().text_size(12).text_color(t.muted)
        .child(div().font_semibold().child(r.workflowName))
        .child(div().child(`#${r.number}`))
        .child(div().px(6).py(1).rounded(4).bg(`${p.link}18`).border_1().border_color(`${p.link}55`).text_color(p.link).font_family("JetBrains Mono").text_size(11.5).child(r.headBranch))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.dim).child(ago(r.createdAt))));
  }

  // Compact single-row filter & repo bar
  controlBar(tab, t) {
    const p = primer(t), f = this.f[tab] ?? {}, states = STATES[tab], repo = this.repo(), all = this.all(), e = this.entry();
    const repoLabel = all ? "所有 Repo" : repo ? repo.split("/")[1] : "選擇 Repo";
    return v_flex().flex_none().border_b(1).border_color(t.border).bg(t.surface)
      .child(h_flex().h(38).px(10).gap(6).items_center()
        .child(h_flex().id("repo-switch").h(26).px(8).gap(5).items_center().rounded(5).border_1().border_color(t.border).bg(t.background).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => this.openPicker())
          .child(glyph(all ? "repos" : "repo", 13, t.muted))
          .child(div().max_w(115).truncate().text_size(12.5).font_semibold().child(repoLabel))
          .child(glyph("chevron-down", 12, t.dim)))
        .when(Boolean(states), (el) => el.children(states.map(([s, _g, label]) => {
          const on = f.state === s, entry = this.data[this.key(tab, { ...this.filters(tab), state: s })], n = entry?.items?.length;
          return h_flex().id(`st-${tab}-${s}`).h(26).px(8).gap(4).items_center().rounded(5).cursor_pointer().text_size(12)
            .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold())
            .hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => this.setFilter(tab, { state: s }, cx))
            .child(`${label}${n !== undefined && n !== null ? ` ${n}` : ""}`);
        })))
        .when(tab === "actions", (el) => el
          .child(h_flex().id("ci-all").h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12)
            .bg(!f.failing ? t.selected : "#00000000").text_color(!f.failing ? t.foreground : t.muted)
            .on_click((_e, cx) => this.setFilter("actions", { failing: false }, cx)).child("All"))
          .child(h_flex().id("ci-fail").h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12)
            .bg(f.failing ? t.selected : "#00000000").text_color(f.failing ? p.closed : t.muted)
            .on_click((_e, cx) => this.setFilter("actions", { failing: true }, cx)).child("Failed")))
        .child(div().flex_1())
        .when(tab === "issues" && Boolean(repo) && !all, (x) => x.child(button("new-issue", "+ New issue", t, () => this.create(), { small: true, color: p.open })))
        .child(e.loading ? div().px(6).child(spinner(13, t.muted)) : button("refresh", "", t, (_e, cx) => this.refresh(cx), { icon: "refresh", small: true, invisible: true, tooltip: "重新整理" })))
      .child(h_flex().px(10).pb(8).gap(6).items_center()
        .when(this.logins.length > 1, (x) => {
          const cwd = this.where().cwd, picked = cwd ? this.chosenUser(cwd) : null;
          const how = picked ? "手動指定" : cwd && this.declared[cwd] ? "由 .envrc 指定" : "gh 目前帳號";
          return x.child(h_flex().id("acct").flex_none().max_w(120).h(30).px(8).gap(5).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
            .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
            .tooltip(`GitHub 帳號：${this.account?.login ?? "?"}（${how}）\n點擊選擇帳號`)
            .on_click(() => this.openAccountMenu())
            .child(glyph("user", 12, t.muted))
            .child(div().min_w(0).truncate().child(this.account?.login ?? "?"))
            .child(glyph("chevron-down", 11, t.dim)));
        })
        .child(h_flex().id("filter").flex_1().min_w(0).h(30).px(9).gap(6).items_center().rounded(6).bg(t.background).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(glyph("search", 13, t.muted)).child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
        .when(tab === "issues" || tab === "prs", (x) => x.child(h_flex().id(`mine-${tab}`).h(30).px(8).gap(4).items_center().rounded(6).text_size(12).cursor_pointer()
          .border_1().border_color(f.mine ? p.link : t.border).bg(f.mine ? t.selected : t.background).text_color(f.mine ? p.link : t.muted)
          .on_click((_e, cx) => this.setFilter(tab, { mine: !f.mine }, cx))
          .child(tab === "prs" ? "My PRs" : "Assigned to me"))));
  }

  empty(tab, e, t, filtered) {
    const p = primer(t), f = this.f[tab] ?? {}, repo = this.repo();
    if (!e.at && !e.error) return skeleton(t, 4);
    if (e.error) return blankslate(t, { icon: "alert", tone: p.closed, title: "無法讀取 GitHub 資料", body: e.error, actions: [button("retry", "重試", t, (_e, cx) => this.refresh(cx), { icon: "refresh" })] });
    if (filtered) return blankslate(t, { icon: "search", title: `找不到符合「${this.query.trim()}」的項目`, body: "請嘗試其他關鍵字或清除篩選。", actions: [button("clear", "清除篩選", t, (_e, cx) => { this.input.set_value(""); this.query = ""; cx.notify(); })] });
    if (tab === "prs") return blankslate(t, { icon: "pr-open", title: f.state === "open" ? "目前沒有開啟的 PR" : "沒有符合狀態的 PR", body: f.state === "open" ? "推送分支並建立 PR 後，即可在這裡檢視 Diff 與一鍵合併。" : "" });
    if (tab === "issues") return blankslate(t, {
      icon: "issue-open",
      title: f.state === "open" ? "目前沒有開啟的 Issue" : "沒有已關閉的 Issue",
      body: f.state === "open" ? "可建立新 Issue，並直接從卡片一鍵開啟 Worktree 與派發 Agent。" : "",
      actions: repo && f.state === "open" && !this.all() ? [button("new-iss-empty", "+ New issue", t, () => this.create(), { primary: true })] : [],
    });
    return blankslate(t, { icon: "actions", title: f.failing ? "沒有失敗的 CI 紀錄" : "尚無 GitHub Actions 紀錄", body: "" });
  }

  listBody(tab, t, cx) {
    const e = this.entry(), allItems = e.items ?? [], shown = this.filteredItems(tab);
    let rows;
    if (!shown.length) {
      rows = [this.empty(tab, e, t, allItems.length > 0)];
    } else if (tab === "prs") {
      rows = shown.slice(0, this.limit).map((item, idx) => this.prCard(item, idx, t, cx));
    } else if (tab === "issues") {
      rows = shown.slice(0, this.limit).map((item, idx) => this.issueCard(item, idx, t, cx));
    } else {
      rows = shown.slice(0, this.limit).map((item, idx) => this.runCard(item, idx, t));
    }
    if (shown.length > this.limit) {
      rows.push(h_flex().flex_none().py(10).justify_center().child(button("more", `載入更多（剩餘 ${shown.length - this.limit} 筆）`, t, (_e, cx) => { this.limit += PAGE; cx.notify(); }, { small: true })));
    }
    return v_flex().id(`list-${tab}`).flex_1().min_h(0).overflow_y_scrollbar().py(6).children(rows);
  }

  onKey(e, cx) {
    const k = e.key;
    if (this.typing) {
      if (k === "escape") { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (k === "escape" || k === "q") {
      run("pane.go", { direction: "left" });
      run("layout.hide", { id: "panel" });
      cx.stop_propagation();
      return;
    }
    if (k === "h" || k === "left") {
      run("pane.go", { direction: "left" });
      cx.stop_propagation();
      return;
    }
    if (k === "/") {
      this.typing = true;
      this.input.focus();
      cx.stop_propagation(); cx.notify();
      return;
    }
    if (k === "1") { this.setTab("prs", cx); cx.stop_propagation(); return; }
    if (k === "2") { this.setTab("issues", cx); cx.stop_propagation(); return; }
    if (k === "3") { this.setTab("actions", cx); cx.stop_propagation(); return; }
    if (k === "r") { this.refresh(cx); cx.stop_propagation(); return; }
    if (k === "n" && !e.modifiers?.control && this.shownTab() === "issues" && this.repo() && !this.all()) {
      this.create();
      cx.stop_propagation();
      return;
    }
    const items = this.filteredItems();
    if (!items.length) return;
    const sel = items[this.selectedIdx] ?? items[0];
    if (k === "j" || k === "down" || ((k === "j" || k === "n") && e.modifiers?.control)) {
      this.selectedIdx = (this.selectedIdx + 1) % items.length;
      cx.stop_propagation(); cx.notify();
    } else if (k === "k" || k === "up" || ((k === "k" || k === "p") && e.modifiers?.control)) {
      this.selectedIdx = (this.selectedIdx + items.length - 1) % items.length;
      cx.stop_propagation(); cx.notify();
    } else if (k === "enter" || k === "d") {
      if (!sel) return;
      const tab = this.shownTab();
      if (tab === "actions") this.openRun(sel);
      else this.open(sel, tab === "prs" ? "pr" : "issue");
      cx.stop_propagation();
    } else if (k === "m" && this.shownTab() === "prs" && sel) {
      this.inlineMergeNum = this.inlineMergeNum === sel.number ? null : sel.number;
      cx.stop_propagation(); cx.notify();
    } else if (k === "w" && this.shownTab() === "issues" && sel) {
      const bound = this.boundWorktreeForIssue(sel.repo, sel.number);
      if (bound) run("space.select", { id: bound.space.id });
      else this.openWorktree(sel);
      cx.stop_propagation();
    } else if (k === "a" && sel && this.shownTab() !== "actions") {
      this.startAgent(sel, this.shownTab() === "prs" ? "pr" : "issue", cx);
      cx.stop_propagation();
    } else if (k === "o" && sel?.url) {
      openUrl(sel.url);
      cx.stop_propagation();
    }
  }

  shell(t) {
    return v_flex().id("git-remote").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(14).track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx));
  }

  render(cx) {
    const t = theme();
    this.here = null;
    if (this.viewer) return this.viewer.render(cx);
    if (this.runView) return this.runView.render(cx);
    if (this.agentMenu) return this.agentMenu.render(cx, t);
    if (this.copying) return renderCopyMenu(this.copying.items, this.copying.overlay, t);
    if (this.picker) return this.renderPicker(t);
    if (this.accountMenu) return this.renderAccountMenu(t);
    if (this.form) return this.renderCreate(t);

    const extTab = shared("git-remote.tab");
    if (extTab && TABS[extTab] && extTab !== this.tab) {
      this.tab = extTab;
      this.selectedIdx = 0;
      this.refresh(cx, true);
    }
    const focusReq = shared("git.focus");
    if (focusReq?.at && focusReq.at !== this.focusAt && focusReq.target === "git-remote") {
      this.focusAt = focusReq.at;
      this.typing = false;
      cx.timer.after(40, () => this.handle.focus());
    }

    const away = hidden(), ctx = JSON.stringify([this.where().cwd, this.where().space]);
    if (this.away && !away) {
      this.typing = false;
      cx.timer.after(40, () => this.handle.focus());
    }
    if ((this.away && !away) || (!away && ctx !== this.ctx)) { this.ctx = ctx; this.refresh(cx, true); }
    this.away = away;
    const changed = shared("git-remote.changed");
    if (changed?.at && changed.at !== this.changedAt) { this.changedAt = changed.at; this.refresh(cx, true); }
    const picked = shared("git-remote.pick");
    if (picked?.at && picked.at !== this.pickedAt) { this.pickedAt = picked.at; this.setPin(picked.space, picked.value, cx); }
    const acct = shared("git-remote.pick-account");
    if (acct?.at && acct.at !== this.acctAt) { this.acctAt = acct.at; this.chooseUser(acct.dir, acct.user, cx); }

    const other = this.foreign();
    if (other && !this.scope()) return this.shell(t).child(blankslate(t, { icon: "repo", title: `偵測到 ${other.label}，目前僅支援 GitHub`,
      body: `origin 指向 ${other.host}/${other.slug}。這個面板的 PR / Issue / CI 透過 GitHub CLI (gh) 取得，${other.label} 的內容尚無法顯示；Changes 與 Graph 分頁不受影響。`,
      actions: [button("pick", "選擇 GitHub Repo", t, () => this.openPicker(), { icon: "repos", primary: true })] }));
    const a = this.account;
    if (!a) return this.shell(t).child(blankslate(t, { icon: "spin", title: "正在連線至 GitHub…", body: "讀取本機 gh 登入狀態中。" }));
    if (a.state === "missing") return this.shell(t).child(blankslate(t, { icon: "github", title: "找不到 GitHub CLI (gh)", body: "請先安裝 gh 並登入帳號。", actions: [button("install", "前往安裝 gh", t, () => openUrl("https://cli.github.com"), { icon: "external", primary: true })] }));
    if (a.state !== "ready") return this.shell(t).child(blankslate(t, { icon: "key", title: a.state === "logged_out" ? "尚未登入 GitHub CLI" : "無法連線至 GitHub", body: a.state === "logged_out" ? "請在終端機執行 gh auth login 完成驗證。" : a.detail, code: a.state === "logged_out" ? "gh auth login" : null,
      actions: [button("login", "開新 Tab 登入", t, () => run("terminal.open", { argv: ["sh", "-c", 'gh auth login; exec "${SHELL:-sh}"'], place: "tab" }), { icon: "terminal" }),
        button("recheck", "重新檢查", t, (_e, cx) => { this.account = null; cx.spawn(async (cx) => { this.account = await account(); this.refresh(cx); cx.notify(); }); cx.notify(); }, { icon: "refresh" }),
        ...(this.logins.length > 1 ? [button("switch-account", "選擇帳號", t, () => this.openAccountMenu(), { icon: "user" })] : [])] }));
    if (!this.scope()) return this.shell(t).child(blankslate(t, { icon: "repo", title: "此目錄沒有綁定 GitHub Repo", body: "將游標移至含 GitHub remote 的專案終端機，或手動選擇一個專案。",
      actions: [button("pick", "選擇 Repo", t, () => this.openPicker(), { icon: "repos", primary: true }),
        button("all-repos", "檢視所有 Repo", t, (_e, cx) => this.setPin(this.where().space, "all", cx), { icon: "repos" })] }));

    const tab = this.shownTab();
    if (!this.entry().at && !this.entry().loading && !this.entry().error) this.refresh(cx, true);
    return this.shell(t)
      .child(this.controlBar(tab, t))
      .child(this.listBody(tab, t, cx));
  }

  // ---- Repository picker popup ----
  openPicker(at = "pointer") {
    openOverlay({ mod: "git-remote", kind: "popup", width: 340, height: 440, at, props: { picker: { space: this.where().space, repo: this.spaceRepos[this.where().space] ?? null, pin: this.pin(), owners: this.owners() } } });
  }
  initPicker(spec, overlay, cx) {
    const cache = `d:picker:${shared("git-remote.user") ?? ""}`;
    this.picker = { ...spec, overlay, repos: remembered(cache, null), q: "" };
    this.pickInput = InputState.new({ placeholder: "搜尋 Repo…" });
    this.pickInput.on("change", (_e, cx) => { this.picker.q = this.pickInput.value(); cx.notify(); });
    this.locals = {};
    cx.spawn(async (cx) => {
      try { const got = await load.repos({ owners: spec.owners }); this.picker.repos = got; keep(cache, got); } catch (e) { this.picker.error = String(e?.message ?? e); }
      cx.notify();
    });
  }
  pick(value) { setShared("git-remote.pick", { space: this.picker.space, value, at: Date.now() }); closeOverlay(this.picker.overlay); }
  renderAccountMenu(t) {
    const p = primer(t), m = this.accountMenu, active = m.logins.find((l) => l.active)?.login;
    const row = (id, title, note, on, user) => h_flex().id(id).h(46).flex_none().px(10).gap(10).items_center().rounded(6).cursor_pointer().hover((x) => x.bg(t.hover))
      .on_click(() => { setShared("git-remote.pick-account", { dir: m.dir, user, at: Date.now() }); closeOverlay(m.overlay); })
      .child(div().w(14).flex_none().child(on ? glyph("check", 14, p.link) : div()))
      .child(glyph("user", 15, t.muted))
      .child(v_flex().flex_1().min_w(0).child(div().text_size(13).truncate().font_medium().child(title)).child(div().text_size(11).text_color(t.muted).truncate().child(note)));
    return v_flex().id("account-menu").size_full().bg(t.popover).text_color(t.foreground)
      .child(div().px(12).pt(10).pb(6).text_size(12.5).font_semibold().child("選擇 GitHub 帳號"))
      .child(v_flex().px(4).pb(6)
        .child(row("acct-auto", "自動", m.declared ? `依 .envrc：${m.declared}` : `gh 目前帳號：${active ?? "?"}`, m.picked === "", ""))
        .child(div().mx(10).my(4).h(1).bg(t.border))
        .children(m.logins.map((l) => row(`acct-${l.login}`, l.login, [l.active && "gh 目前帳號", m.declared === l.login && ".envrc 指定"].filter(Boolean).join(" · ") || "已登入", m.picked === l.login, l.login))));
  }

  renderPicker(t) {
    const p = primer(t), s = this.picker, q = s.q.trim().toLowerCase();
    const row = (id, g, title, note, on, onClick) => h_flex().id(id).h(40).flex_none().px(10).gap(10).items_center().rounded(6).cursor_pointer().hover((x) => x.bg(t.hover)).on_click(onClick)
      .child(div().w(14).flex_none().child(on ? glyph("check", 14, p.link) : div()))
      .child(glyph(g, 15, t.muted))
      .child(v_flex().flex_1().min_w(0).child(div().text_size(13).truncate().font_medium().child(title)).when(Boolean(note), (x) => x.child(div().text_size(11).text_color(t.muted).truncate().child(note))));
    const repos = (s.repos ?? []).filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q));
    return v_flex().id("picker").size_full().bg(t.popover).text_color(t.foreground)
      .child(div().px(12).pt(10).pb(8).text_size(12.5).font_semibold().child("切換 GitHub 專案"))
      .child(h_flex().mx(10).mb(8).h(30).px(9).gap(7).items_center().rounded(6).bg(t.input ?? t.background).border_1().border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(glyph("search", 14, t.muted)).child(Input.new(this.pickInput).flex_1().h_full().text_size(12.5)))
      .child(v_flex().id("picker-list").flex_none().h(372).overflow_y_scrollbar().px(4).pb(6)
        .when(!q, (x) => x.child(row("pick-follow", "terminal", "跟隨目前終端機", s.repo ?? "自動偵測游標所在的 Repo", !s.pin, () => this.pick(null)))
          .child(row("pick-all", "repos", "所有專案 (All repositories)", "跨專案檢視你的 Issues 與 PRs", s.pin === "all", () => this.pick("all")))
          .child(div().mx(10).my(6).h(1).bg(t.border)))
        .when(!s.repos && !s.error, (x) => x.child(div().px(12).py(8).text_size(12).text_color(t.muted).child("載入專案清單中…")))
        .when(Boolean(s.error), (x) => x.child(div().px(12).py(8).text_size(12).text_color(p.closed).child(s.error)))
        .children(repos.map((r) => row(`pick-${r.nameWithOwner}`, r.isPrivate ? "lock" : "repo", r.nameWithOwner, `${r.primaryLanguage?.name ? `${r.primaryLanguage.name} · ` : ""}更新於 ${ago(r.pushedAt)}`, s.pin === r.nameWithOwner, () => this.pick(r.nameWithOwner)))));
  }

  // ---- New Issue dialog ----
  create() { openOverlay({ mod: "git-remote", kind: "dialog", modal: true, width: 640, height: 480, props: { create: { repo: this.repo(), me: this.account?.login, locals: this.localFor(this.repo()) } } }); }
  initCreate(spec, overlay, cx) {
    this.form = { ...spec, overlay };
    this.titleInput = InputState.new({ placeholder: "輸入 Issue 標題…" });
    this.bodyInput = TextareaState.new({ placeholder: "描述需求、問題重現步驟或驗收條件（支援 Markdown）…" });
    this.bodyInput.set_auto_grow(8, 14);
    this.titleInput.on("change", (_e, cx) => cx.notify());
  }
  submit(cx) {
    const f = this.form, title = this.titleInput.value().trim();
    if (!title || f.busy) return;
    f.busy = true; f.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const url = (await gh(["issue", "create", "-R", f.repo, "--title", title, "--body", this.bodyInput.value().trim()])).trim().split("\n").pop();
        const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
        setShared("git-remote.changed", { repo: f.repo, at: Date.now() });
        closeOverlay(f.overlay);
        if (number) openOverlay({ mod: "git-remote", kind: "dialog", width: 0.88, height: 0.92, props: { item: { kind: "issue", repo: f.repo, number, me: f.me, locals: f.locals } } });
      } catch (e) { f.error = String(e?.message ?? e); f.busy = false; cx.notify(); }
    });
  }
  renderCreate(t) {
    const p = primer(t), f = this.form, ok = Boolean(this.titleInput.value().trim());
    return v_flex().id("create").size_full().bg(t.background).text_color(t.foreground).px(24).py(18).gap(14)
      .child(h_flex().gap(8).items_center().child(glyph("issue-open", 16, p.open)).child(div().text_size(16).font_semibold().child("建立新 Issue"))
        .child(div().text_size(13).text_color(t.muted).child(f.repo)).child(div().flex_1())
        .child(button("create-close", "", t, () => closeOverlay(f.overlay), { icon: "close", invisible: true })))
      .child(v_flex().gap(6).child(div().text_size(12.5).font_semibold().child("標題"))
        .child(div().id("create-title").h(34).px(10).flex().items_center().rounded(6).bg(t.input ?? t.background).border_1().border_color(t.border).cursor_text()
          .child(Input.new(this.titleInput).w_full().h_full().text_size(14))))
      .child(v_flex().flex_1().min_h(0).gap(6).child(div().text_size(12.5).font_semibold().child("內容說明"))
        .child(div().id("create-body").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(8).rounded(6).bg(t.input ?? t.background).border_1().border_color(t.border).cursor_text()
          .child(Textarea.new(this.bodyInput).w_full().text_size(13.5))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(f.error ? p.closed : t.muted).child(f.error ?? "建立後可直接從卡片一鍵開啟 Worktree 並派發 Agent。"))
        .child(button("create-cancel", "取消", t, () => closeOverlay(f.overlay)))
        .child(button("create-submit", f.busy ? "建立中…" : "建立 Issue", t, (_e, cx) => this.submit(cx), { primary: true, enabled: ok && !f.busy })));
  }
}
