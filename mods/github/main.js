import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, hc, run, layout, theme, openOverlay, closeOverlay, notify, props, shared, setShared, nextCommand } from "herdr";
import { primer, glyph, spinner, ago, day, openUrl, issueState, prState, runState, checksOf, glyphOf, labelChip, button, counter, blankslate, skeleton, badge } from "./ui.js";
import { gh, ghJson, account, repoOf, checkouts, load, localState, ROOTS } from "./gh.js";
import { issueBrief, prBrief } from "./brief.js";
import { Viewer } from "./viewer.js";
import { RunView } from "./run.js";
import { AgentMenu, copied, pickAgent, copyMenu, renderCopyMenu, openIssueWorktree } from "./actions.js";

const PAGE = 50, SYNC = 60000, LIVE = 10000, SCAN = 4000;
const TABS = {
  issues: { label: "Issues", icon: "issue-open" },
  prs: { label: "Pull requests", short: "PRs", icon: "pr-open" },
  actions: { label: "Actions", icon: "actions" },
  milestones: { label: "Milestones", icon: "milestone" },
  projects: { label: "Projects", icon: "project" },
  repo: { label: "Repository", short: "Repo", icon: "repo" },
  repos: { label: "Repositories", short: "Repos", icon: "repos" },
};
const REPO_TABS = ["issues", "prs", "actions", "milestones", "projects", "repo"];
const ALL_TABS = ["issues", "prs", "repos", "projects"];
const STATES = {
  issues: [["open", "issue-open", "Open"], ["closed", "check", "Closed"]],
  prs: [["open", "pr-open", "Open"], ["merged", "pr-merged", "Merged"], ["closed", "pr-closed", "Closed"]],
  milestones: [["open", "milestone", "Open"], ["closed", "check", "Closed"]],
};

const remembered = (key, fallback = {}) => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full: memory only */ } };
function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}
// Only the shown panel works; a pane copy always does.
function hidden() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body"), gitBody = find(root, "git-body");
  if (!panel) return false;
  if (panel.hidden) return true;
  if (gitBody) return body?.active !== "git" || gitBody.active !== "github";
  if (!body?.children?.some((c) => c.content?.mod === "github")) return false;
  return find(body, body.active)?.content?.mod !== "github";
}
function location(last) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal && last) return last;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null, space: f?.space ?? space?.id };
}
function mentions(text, repo) {
  const found = [], re = new RegExp(`(?:^|[^\\w&/#])#(\\d{1,5})(?![\\w-])|github\\.com/${repo.replace(/\./g, "\\.")}/(?:issues|pull)/(\\d+)`, "g");
  for (const line of text.split("\n").reverse()) for (const m of line.matchAll(re)) { const n = Number(m[1] ?? m[2]); if (!found.includes(n)) found.push(n); }
  return found;
}

export default class GitHub extends View {
  init(_props, cx) {
    const pr = props() ?? {};
    if (pr.item) { this.viewer = new Viewer(pr.item, pr.overlay, cx); return; }
    if (pr.run) { this.runView = new RunView(pr.run, pr.overlay, cx); return; }
    if (pr.agentMenu) { this.agentMenu = new AgentMenu(pr.agentMenu, pr.overlay, cx); return; }
    if (pr.copyMenu) { this.copying = { items: pr.copyMenu, overlay: pr.overlay }; return; }
    if (pr.picker) { this.initPicker(pr.picker, pr.overlay, cx); return; }
    if (pr.create) { this.initCreate(pr.create, pr.overlay, cx); return; }

    this.fixed = pr.repo ?? null; // a pane copy fixed on one repository: { "mod": "github", "props": { "repo": "owner/name" } }
    this.roots = Array.isArray(pr.roots) ? pr.roots : []; // more folders holding clones: { "props": { "roots": ["Documents/work"] } }
    this.repos = remembered("repos"); this.pins = remembered("pins"); this.spaceRepos = remembered("spaces");
    this.tab = shared("github.tab") ?? "issues";
    this.f = remembered("filters", null) ?? { issues: { state: "open", mine: false }, prs: { state: "open", mine: false }, actions: { failing: false, branch: false }, milestones: { state: "open" } };
    this.limit = PAGE; this.data = {}; this.locals = {}; this.counts = remembered("counts"); this.mentioned = []; this.query = "";
    this.input = InputState.new({ placeholder: "Filter by title, number, label, author…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.limit = PAGE; cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.changedAt = shared("github.changed")?.at; this.pickedAt = shared("github.pick")?.at;
    cx.spawn(async (cx) => {
      this.account = await account(); cx.notify();
      if (this.account.state === "ready") this.refresh(cx);
      this.locals = await checkouts(this.roots); cx.notify();
    });
    cx.timer.every(SYNC, (cx) => { if (!hidden()) this.refresh(cx, true); });
    cx.timer.every(LIVE, (cx) => { if (!hidden() && this.tab === "actions" && this.items()?.some((r) => r.status !== "completed")) this.refresh(cx, true); });
    cx.timer.every(SCAN, (cx) => { if (!hidden()) this.scan(cx); });
    // keys.json: "alt-g i": "github.issues", or github.prs|actions|milestones|projects|repo|repos|refresh|open|switch|all|follow.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (TABS[c]) this.setTab(c, cx);
        else if (c === "refresh") this.refresh(cx);
        else if (c === "open") this.openFirst();
        else if (c === "switch" && !this.fixed) this.openPicker();
        else if (c === "all" || c === "follow") this.setPin(this.where().space, c === "all" ? "all" : null, cx);
        cx.notify();
      }
    });
  }

  // ---- where we are ----
  // Read once per render: every row asks, and each read crosses into the app.
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
  tabs() { return this.all() ? ALL_TABS : REPO_TABS; }
  shownTab() { return this.tabs().includes(this.tab) ? this.tab : "issues"; }
  filters(tab = this.shownTab()) {
    const f = { ...(this.f[tab] ?? {}) };
    if (tab === "actions") f.branch = f.branch ? this.locals[this.repo()]?.branch ?? null : null;
    return f;
  }
  key(tab = this.shownTab(), f = this.filters(tab)) { return `${this.scopeKey()}|${tab}|${JSON.stringify(f)}`; }
  entry(key = this.key()) { return (this.data[key] ??= { items: remembered(`d:${key}`, null), at: 0 }); }
  items() { return this.entry().items; }

  // The focused terminal's repo, by its origin remote. A terminal outside any repo means none:
  // never another tab's repo remembered from earlier (a panel or file pane keeps the last terminal, see location()).
  async follow() {
    const { cwd, on, space } = this.where();
    if (!cwd || on) return;
    const id = JSON.stringify([cwd, on]);
    if (!(id in this.repos)) { this.repos[id] = await repoOf(cwd, on); keep("repos", this.repos); }
    const found = this.repos[id] ?? null;
    if ((this.spaceRepos[space] ?? null) !== found) { this.spaceRepos[space] = found; keep("spaces", this.spaceRepos); this.mentioned = []; }
  }

  refresh(cx, quiet = false) {
    if (this.account?.state !== "ready") return;
    cx.spawn(async (cx) => {
      await this.follow();
      const scope = this.scope();
      if (!scope) return cx.notify();
      const tab = this.shownTab(), key = this.key(tab), e = this.entry(key);
      if (e.loading) return;
      e.loading = true; if (!quiet) e.error = null; cx.notify();
      try {
        if (tab === "actions" && this.f.actions.branch && scope.repo) await this.readLocal(scope.repo);
        const f = this.filters(tab), real = this.key(tab, f), got = await load[tab](scope, f);
        const target = this.entry(real);
        target.items = got; target.at = Date.now(); target.error = null;
        if (["issues", "prs", "actions", "milestones", "repos"].includes(tab)) keep(`d:${real}`, got.slice(0, 200));
        if ((tab === "issues" || tab === "prs") && f.state === "open" && !f.mine && !f.milestone) this.setCount(tab, got);
      } catch (err) { e.error = String(err?.message ?? err); e.scope = /read:project|scopes?/.test(e.error); }
      finally { e.loading = false; cx.notify(); }
      // Counts on the tabs: the open issues and pull requests, fetched once per scope.
      for (const t of ["issues", "prs"]) {
        const sk = this.scopeKey();
        if (this.count(t) === null && !this.counting?.[`${sk}|${t}`]) {
          (this.counting ??= {})[`${sk}|${t}`] = true;
          load[t](scope, { state: "open", mine: false }).then((got) => { this.setCount(t, got, sk); cx.notify(); }).catch(() => {});
        }
      }
    });
  }
  // Open issues and pull requests per scope: the tab counters and the repos' counts.
  count(tab) { return this.counts?.[this.scopeKey()]?.[tab] ?? null; }
  setCount(tab, items, sk = this.scopeKey()) {
    ((this.counts ??= remembered("counts"))[sk] ??= {})[tab] = items.length;
    if (sk === "all") this.counts.byRepo = items.reduce((m, i) => { ((m[i.repo] ??= {})[tab] = (m[i.repo]?.[tab] ?? 0) + 1); return m; }, Object.fromEntries(Object.entries(this.counts.byRepo ?? {}).map(([r, c]) => [r, { ...c, [tab]: 0 }])));
    keep("counts", this.counts);
  }
  async readLocal(repo) {
    const local = this.locals[repo];
    if (local?.folder) Object.assign(local, await localState(local.folder) ?? {});
  }

  // #123 and issue links on the focused terminal, pinned on top.
  scan(cx) {
    const terminal = (this.terminal = focused()?.terminal ?? this.terminal), repo = this.repo();
    if (this.scanning || !terminal || !repo || this.all() || !["issues", "prs"].includes(this.shownTab())) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", terminal, "--lines", "300"]);
        if (r.code !== 0) return;
        const found = mentions(r.stdout, repo).slice(0, 12);
        if (JSON.stringify(found) !== JSON.stringify(this.mentioned)) { this.mentioned = found; cx.notify(); }
      } catch { /* terminal gone */ } finally { this.scanning = false; }
    });
  }

  setTab(tab, cx) { this.tab = tab; this.limit = PAGE; setShared("github.tab", tab); this.refresh(cx); cx.notify(); }
  setFilter(tab, patch, cx) { this.limit = PAGE; this.f[tab] = { ...this.f[tab], ...patch }; keep("filters", this.f); this.refresh(cx); cx.notify(); }
  setPin(space, value, cx) {
    if (value) this.pins[space] = value; else delete this.pins[space];
    keep("pins", this.pins); this.mentioned = []; this.refresh(cx); cx.notify();
  }

  // ---- opening things ----
  localFor(repo) { const l = this.locals[repo]; return l ? { [repo]: { folder: l.folder, space: l.space ?? null } } : {}; }
  open(item, kind) {
    openOverlay({ mod: "github", kind: "dialog", width: 0.88, height: 0.92, props: { item: { kind, repo: item.repo, number: item.number, me: this.account?.login, locals: this.localFor(item.repo), data: kind === "pr" ? null : item.body !== undefined ? item : null } } });
  }
  openRun(r) {
    const l = this.locals[r.repo];
    openOverlay({ mod: "github", kind: "dialog", width: 0.8, height: 0.88, props: { run: { run: r, local: l ? { folder: l.folder, space: l.space ?? null } : null } } });
  }
  // Full detail first, so the brief has the body, the discussion and the checks.
  async brief(item, kind) {
    const fields = kind === "pr"
      ? "number,title,body,author,state,labels,assignees,comments,url,headRefName,baseRefName,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,reviews,closingIssuesReferences,milestone"
      : "number,title,body,author,state,labels,assignees,comments,url,milestone";
    const full = { ...await ghJson([kind === "pr" ? "pr" : "issue", "view", String(item.number), "-R", item.repo, "--json", fields]), repo: item.repo };
    if (kind === "pr") full.checks = checksOf(full);
    const l = this.locals[item.repo], local = l ? { ...l, ...(await localState(l.folder) ?? {}) } : null;
    return kind === "pr" ? prBrief(full, { local }) : issueBrief(full, { local });
  }
  copyBrief(item, kind, cx) {
    notify({ title: "Preparing brief…", body: `${item.repo}#${item.number}`, timeout: 1500 });
    cx.spawn(async (cx) => {
      try { copied(cx, await this.brief(item, kind), "Brief copied", `${item.repo}#${item.number} · ready to paste into an agent`); }
      catch (e) { notify({ title: "Brief failed", body: String(e?.message ?? e), level: "error" }); }
    });
  }
  startAgent(item, kind, cx) {
    cx.spawn(async () => {
      try {
        const l = this.locals[item.repo];
        pickAgent({
          name: `${kind === "pr" ? "PR " : ""}#${item.number} ${item.repo.split("/")[1]}`,
          brief: await this.brief(item, kind),
          folder: l?.folder ?? null,
          space: l?.space ?? null,
          issue: kind === "issue" ? { number: item.number, title: item.title } : null,
        });
      } catch (e) { notify({ title: "Brief failed", body: String(e?.message ?? e), level: "error" }); }
    });
  }
  openWorktree(item) {
    const l = this.locals[item.repo];
    openIssueWorktree({ issue: { number: item.number, title: item.title }, folder: l?.folder ?? null, space: l?.space ?? null })
      .catch((e) => notify({ title: "Worktree failed", body: String(e?.message ?? e), level: "error" }));
  }
  // The top row: the issue the terminal mentioned last, else the first of the list.
  openFirst() {
    const tab = this.shownTab(), items = this.items() ?? [];
    if (tab === "actions") return items[0] && this.openRun(items[0]);
    if (tab !== "issues" && tab !== "prs") return;
    const item = this.mentioned.map((n) => items.find((i) => i.number === n)).find(Boolean) ?? items[0];
    if (item) this.open(item, tab === "prs" ? "pr" : "issue");
  }
  copyItem(item) {
    copyMenu([["Copy link", item.url], ["Copy reference", `${item.repo}#${item.number}`], ["Copy number and title", `#${item.number} ${item.title}`]], "pointer");
  }

  // ---- drawing: rows ----
  matches(text) { const q = this.query.trim().toLowerCase(); return !q || text.toLowerCase().includes(q); }
  hoverable(el, key) { return el.on_hover((on, cx) => { if (on) { if (this.hover !== key) { this.hover = key; cx.notify(); } } else if (this.hover === key) { this.hover = null; cx.notify(); } }); }
  rowActions(item, kind, t) {
    return h_flex().flex_none().gap(2).items_center()
      .when(kind === "issue", (e) => e.child(button(`wt-${item.repo}-${item.number}`, "", t, (_e, cx) => { cx.stop_propagation(); this.openWorktree(item); }, { icon: "branch", invisible: true, small: true, tooltip: "Open worktree for this issue" })))
      .child(button(`brief-${kind}-${item.repo}-${item.number}`, "", t, (_e, cx) => { cx.stop_propagation(); this.copyBrief(item, kind, cx); }, { icon: "brief", invisible: true, small: true, tooltip: "Copy agent brief" }))
      .child(button(`agent-${kind}-${item.repo}-${item.number}`, "", t, (_e, cx) => { cx.stop_propagation(); this.startAgent(item, kind, cx); }, { icon: "agent", invisible: true, small: true, tooltip: "Start an agent on it" }));
  }

  itemRow(item, kind, t, where = "list") {
    const p = primer(t), key = `${where}-${kind}-${item.repo}-${item.number}`, hovered = this.hover === key;
    const [g, color] = kind === "pr" ? prState(item, p) : issueState(item, p);
    const checks = kind === "pr" && item.statusCheckRollup ? checksOf(item) : null;
    const meta = [`#${item.number}`, this.all() ? item.repo.split("/")[1] : null, kind === "pr" && item.headRefName ? item.headRefName : null, `${String(item.state).toUpperCase() === "OPEN" ? "opened" : "updated"} ${ago(String(item.state).toUpperCase() === "OPEN" ? item.createdAt : item.updatedAt)}`, item.author?.login ? `by ${item.author.login.replace(/^app\//, "")}` : null].filter(Boolean).join(" · ");
    const review = { APPROVED: ["check", p.open, "Approved"], CHANGES_REQUESTED: ["x-circle", p.closed, "Changes requested"] }[item.reviewDecision];
    return this.hoverable(h_flex().id(key).relative().flex_none().px(14).py(10).gap(10).items_start().border_b(1).border_color(t.border).cursor_pointer()
      .bg(hovered ? t.hover : "#00000000")
      .on_click(() => this.open(item, kind))
      .on_mouse_down("right", () => this.copyItem(item))
      .child(div().pt(2).child(glyph(g, 16, color)))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(div().text_size(14.5).font_semibold().text_color(t.foreground).child(item.title))
        .child(div().text_size(12.5).text_color(t.muted).child(meta))
        // Labels on their own row: sharing the meta's row, the last one wrapped alone.
        .when(item.labels?.length > 0, (e) => e.child(h_flex().gap(5).flex_wrap().items_center().children(item.labels.slice(0, 4).map((l) => labelChip(l, t, true))))))
      .child(v_flex().flex_none().items_end().gap(4).pt(1)
        .child(h_flex().gap(8).items_center().text_size(12.5).text_color(t.muted)
            .when(Boolean(checks?.state), (e) => e.child(glyphOf(checks.state === "failure" ? "x-circle" : checks.state === "pending" ? "dot" : "check", 15, checks.state === "failure" ? p.closed : checks.state === "pending" ? p.attention : p.open, t)))
            .when(Boolean(review), (e) => e.child(glyph(review[0], 15, review[1])))
            .when(item.comments > 0, (e) => e.child(h_flex().gap(3).items_center().child(glyph("comment", 13, t.muted)).child(String(item.comments)))))
        .when(item.assignees?.length > 0, (e) => e.child(div().text_size(12).text_color(t.dim).child(item.assignees.map((a) => a.login).join(", ")))))
      // Over the row's corner, so showing them never moves the text.
      .when(hovered, (e) => e.child(div().absolute().top(6).right(8).p(2).rounded(7).bg(t.raised).border_1().border_color(t.border).child(this.rowActions(item, kind, t)))), key);
  }

  runRow(r, t) {
    const p = primer(t), key = `run-${r.databaseId}`, hovered = this.hover === key, [g, color] = runState(r, p);
    return this.hoverable(h_flex().id(key).relative().flex_none().px(14).py(10).gap(10).items_start().border_b(1).border_color(t.border).cursor_pointer()
      .bg(hovered ? t.hover : "#00000000").on_click(() => this.openRun(r))
      .on_mouse_down("right", () => copyMenu([["Copy link", r.url], ["Copy rerun command", `gh run rerun ${r.databaseId} -R ${r.repo} --failed`]], "pointer"))
      .child(div().pt(2).child(glyphOf(g, 16, color, t)))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(div().text_size(14.5).font_semibold().child(r.displayTitle))
        .child(h_flex().gap(6).flex_wrap().items_center().text_size(12.5).text_color(t.muted)
          .child(div().font_semibold().child(r.workflowName))
          .child(div().child(`#${r.number}`))
          .child(div().px(6).py(1).rounded(4).bg(`${p.link}1f`).text_color(p.link).font_family("JetBrains Mono").text_size(12).child(r.headBranch))
          .child(div().child(`${r.event} · ${ago(r.createdAt)}`))))
      .when(hovered && /failure|timed_out/.test(r.conclusion ?? ""), (e) => e.child(div().absolute().top(5).right(8).p(2).rounded(7).bg(t.raised).border_1().border_color(t.border).child(button(`rerun-${r.databaseId}`, "", t, (_e, cx) => {
        cx.spawn(async (cx) => { try { await gh(["run", "rerun", String(r.databaseId), "-R", r.repo, "--failed"]); notify({ title: "Re-running failed jobs", body: r.workflowName, level: "success" }); this.refresh(cx); } catch (err) { notify({ title: "Re-run failed", body: String(err.message), level: "error" }); } });
      }, { icon: "refresh", invisible: true, small: true, tooltip: "Re-run failed jobs" })))), key);
  }

  milestoneRow(m, t) {
    const p = primer(t), total = m.open + m.closed, pct = total ? Math.round(m.closed * 100 / total) : 0;
    const late = m.state === "open" && m.due && Date.parse(m.due) < Date.now();
    return h_flex().id(`ms-${m.number}`).flex_none().px(14).py(10).gap(10).items_start().border_b(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.f.issues = { state: "open", mine: false, milestone: m.title }; keep("filters", this.f); this.setTab("issues", cx); })
      .on_mouse_down("right", () => openUrl(m.url))
      .child(div().pt(2).child(glyph("milestone", 16, m.state === "open" ? p.open : p.done)))
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().text_size(14.5).font_semibold().child(m.title))
        .child(div().h(8).w_full().rounded(4).bg(t.raised).overflow_hidden().child(div().h_full().w(`${pct}%`).rounded(4).bg(p.open)))
        .child(h_flex().gap(10).flex_wrap().text_size(12.5).text_color(t.muted)
          .child(div().font_semibold().text_color(t.foreground).child(`${pct}%`)).child(div().child(`${m.open} open`)).child(div().child(`${m.closed} closed`))
          .child(div().text_color(late ? p.closed : t.muted).child(m.due ? `${late ? "Past due" : "Due"} ${day(m.due)}` : "No due date"))))
      .child(button(`ms-open-${m.number}`, "", t, () => openUrl(m.url), { icon: "external", invisible: true, small: true, tooltip: "Open on GitHub" }));
  }

  projectRow(pj, t) {
    return h_flex().id(`pj-${pj.owner}-${pj.number}`).flex_none().px(14).py(10).gap(10).items_start().border_b(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => openUrl(pj.url))
      .child(div().pt(2).child(glyph("project", 16, t.muted)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(div().text_size(14.5).font_semibold().child(pj.title))
        .child(h_flex().gap(8).text_size(12.5).text_color(t.muted).child(div().child(`${pj.owner} · #${pj.number}`)).child(div().child(`${pj.items} items`))
          .when(Boolean(pj.shortDescription), (e) => e.child(div().truncate().child(pj.shortDescription)))))
      .child(glyph("external", 14, t.dim));
  }

  repoRow(r, t, counts) {
    const p = primer(t), local = this.locals[r.nameWithOwner], c = counts[r.nameWithOwner] ?? {};
    const [owner, name] = r.nameWithOwner.split("/");
    return h_flex().id(`repo-${r.nameWithOwner}`).flex_none().px(14).py(10).gap(10).items_start().border_b(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setPin(this.where().space, r.nameWithOwner, cx))
      .on_mouse_down("right", () => openUrl(r.url))
      .child(div().pt(2).child(glyph(r.isPrivate ? "lock" : "repo", 16, t.muted)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().gap(2).text_size(14.5).child(div().text_color(t.muted).child(`${owner}/`)).child(div().font_semibold().text_color(p.link).child(name))
          .when(r.isFork, (e) => e.child(div().pl(6).child(badge("fork", t)))))
        .when(Boolean(r.description), (e) => e.child(div().text_size(13).text_color(t.muted).child(r.description)))
        .child(h_flex().gap(10).flex_wrap().items_center().text_size(12.5).text_color(t.muted)
          .when(Boolean(r.primaryLanguage?.name), (e) => e.child(div().child(r.primaryLanguage.name)))
          .when(r.stargazerCount > 0, (e) => e.child(h_flex().gap(3).items_center().child(glyph("star", 13, t.muted)).child(String(r.stargazerCount))))
          .when(c.issues > 0, (e) => e.child(h_flex().gap(3).items_center().child(glyph("issue-open", 13, p.open)).child(String(c.issues))))
          .when(c.prs > 0, (e) => e.child(h_flex().gap(3).items_center().child(glyph("pr-open", 13, p.open)).child(String(c.prs))))
          .child(div().child(`updated ${ago(r.pushedAt)}`))
          .when(Boolean(local), (e) => e.child(h_flex().gap(3).items_center().text_color(t.foreground).child(glyph("folder", 13, t.muted)).child("cloned")))));
  }

  // ---- drawing: tab bodies ----
  listHeader(tab, t) {
    const p = primer(t), f = this.f[tab] ?? {}, states = STATES[tab];
    const head = h_flex().flex_none().h(38).px(12).gap(14).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(13);
    if (states) {
      head.children(states.map(([s, g, label]) => {
        const on = f.state === s, e = this.data[this.key(tab, { ...this.filters(tab), state: s })], n = e?.items?.length;
        return h_flex().id(`state-${tab}-${s}`).gap(5).items_center().cursor_pointer().text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold())
          .hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => this.setFilter(tab, { state: s }, cx))
          .child(glyph(g, 14, on ? t.foreground : t.muted)).child(div().child(n !== undefined && n !== null ? `${n >= 200 ? "200+" : n} ${label}` : label));
      }));
    }
    if (tab === "actions") {
      head.child(h_flex().id("runs-all").gap(5).items_center().cursor_pointer().text_color(!f.failing ? t.foreground : t.muted).when(!f.failing, (x) => x.font_semibold())
        .on_click((_e, cx) => this.setFilter("actions", { failing: false }, cx)).child(glyph("actions", 14, !f.failing ? t.foreground : t.muted)).child("All runs"))
        .child(h_flex().id("runs-failing").gap(5).items_center().cursor_pointer().text_color(f.failing ? t.foreground : t.muted).when(f.failing, (x) => x.font_semibold())
          .on_click((_e, cx) => this.setFilter("actions", { failing: true }, cx)).child(glyph("x-circle", 14, f.failing ? p.closed : t.muted)).child("Failing"));
    }
    head.child(div().flex_1());
    if (tab === "issues" && f.milestone) head.child(h_flex().id("ms-chip").h(24).px(8).gap(5).items_center().rounded(6).border_1().border_color(t.border).text_size(12).cursor_pointer()
      .hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.setFilter("issues", { milestone: null }, cx))
      .child(glyph("milestone", 12, t.muted)).child(div().max_w(120).truncate().child(f.milestone)).child(glyph("close", 11, t.muted)));
    if (tab === "issues" || tab === "prs") head.child(h_flex().id(`mine-${tab}`).h(24).px(8).gap(5).items_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(f.mine ? p.link : t.border).bg(f.mine ? t.selected : "#00000000").text_color(f.mine ? t.foreground : t.muted)
      .hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => this.setFilter(tab, { mine: !f.mine }, cx))
      .tooltip(tab === "prs" ? "Opened by you" : "Assigned to you").child(glyph("user", 12, f.mine ? p.link : t.muted)).child(tab === "prs" ? "Mine" : "Assigned"));
    if (tab === "actions" && this.locals[this.repo()]) head.child(h_flex().id("runs-branch").h(24).px(8).gap(5).items_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(f.branch ? p.link : t.border).bg(f.branch ? t.selected : "#00000000").text_color(f.branch ? t.foreground : t.muted)
      .on_click((_e, cx) => this.setFilter("actions", { branch: !f.branch }, cx)).tooltip("Runs of the local checkout's branch")
      .child(glyph("branch", 12, f.branch ? p.link : t.muted)).child(f.branch && this.locals[this.repo()]?.branch ? this.locals[this.repo()].branch : "This branch"));
    return head;
  }

  // What to show when a list has nothing: loading, error, no match, or truly empty.
  empty(tab, e, t, filtered) {
    const p = primer(t), f = this.f[tab] ?? {}, repo = this.repo();
    if (!e.at && !e.error) return skeleton(t);
    if (e.error && e.scope) return blankslate(t, { icon: "key", title: "Projects need one more permission", body: "Your gh token can't read projects yet. Run this once in a terminal, then refresh.", code: "gh auth refresh -s read:project",
      actions: [button("copy-scope", "Copy command", t, (_e, cx) => copied(cx, "gh auth refresh -s read:project", "Command copied"), { icon: "copy" }),
        button("run-scope", "Run in a new tab", t, () => run("terminal.open", { argv: ["sh", "-c", 'gh auth refresh -s read:project; exec "${SHELL:-sh}"'], place: "tab" }), { icon: "terminal" })] });
    if (e.error) return blankslate(t, { icon: "alert", tone: p.closed, title: "Couldn't load from GitHub", body: e.error, actions: [button("retry", "Retry", t, (_e, cx) => this.refresh(cx), { icon: "refresh" })] });
    if (filtered) return blankslate(t, { icon: "search", title: `No results for “${this.query.trim()}”`, body: "Nothing in this list matches the filter.", actions: [button("clear", "Clear filter", t, (_e, cx) => { this.input.set_value(""); this.query = ""; cx.notify(); })] });
    const gone = (title, body, extra = []) => blankslate(t, { icon: TABS[tab].icon, title, body, actions: extra });
    if (f.mine) return gone(tab === "prs" ? "You have no pull requests here" : "Nothing is assigned to you here", "The filter hides everyone else's.", [button("all", "Show everyone's", t, (_e, cx) => this.setFilter(tab, { mine: false }, cx))]);
    if (tab === "issues" && f.milestone) return gone(`No ${f.state} issues in ${f.milestone}`, "This milestone has nothing in this state.", [button("ms-clear", "Clear milestone", t, (_e, cx) => this.setFilter("issues", { milestone: null }, cx))]);
    switch (tab) {
      case "issues": return f.state === "open"
        ? gone("No open issues", this.all() ? "Every repository you own is clear. Nice." : "Nothing to fix here right now. Nice.", repo && !this.all() ? [button("new", "New issue", t, () => this.create(), { primary: true, icon: "plus" })] : [])
        : gone("No closed issues", "Closed issues show up here.");
      case "prs": return gone(`No ${f.state} pull requests`, f.state === "open" ? "Push a branch and open one: it shows up here with its checks." : "They show up here once there are some.",
        repo && f.state === "open" && !this.all() ? [button("compare", "Open a pull request", t, () => openUrl(`https://github.com/${repo}/compare`), { icon: "external" })] : []);
      case "actions": return gone(f.failing ? "No failing runs" : "No workflow runs", f.failing ? "Every recent run passed." : "This repository has no GitHub Actions runs yet.",
        !f.failing ? [button("wf", "Set up a workflow", t, () => openUrl(`https://github.com/${repo}/actions/new`), { icon: "external" })] : [button("all-runs", "Show all runs", t, (_e, cx) => this.setFilter("actions", { failing: false }, cx))]);
      case "milestones": return gone(`No ${f.state} milestones`, "Milestones group issues into releases and show their progress.", [button("ms-new", "Create a milestone", t, () => openUrl(`https://github.com/${repo}/milestones/new`), { icon: "external" })]);
      case "projects": return gone("No projects", "Projects plan work across repositories as tables and boards.", [button("pj-new", "Create a project", t, () => openUrl(`https://github.com/${this.all() ? this.account.login : repo.split("/")[0]}?tab=projects`), { icon: "external" })]);
      case "repos": return gone("No repositories", "Repositories you own and your organizations' show up here.");
    }
    return gone("Nothing here", "");
  }

  listBody(tab, t) {
    const e = this.entry(), items = e.items ?? [];
    let rows;
    switch (tab) {
      case "issues": case "prs": {
        const kind = tab === "prs" ? "pr" : "issue";
        const shown = items.filter((i) => this.matches(`#${i.number} ${i.title} ${i.repo} ${i.author?.login ?? ""} ${(i.labels ?? []).map((l) => l.name).join(" ")}`));
        const pinned = this.all() ? [] : this.mentioned.map((n) => items.find((i) => i.number === n)).filter(Boolean).slice(0, 6);
        rows = [
          ...(pinned.length ? [this.heading("In this terminal", t), ...pinned.map((i) => this.itemRow(i, kind, t, "mention")), this.heading(this.all() ? "Everything" : "All", t)] : []),
          ...shown.slice(0, this.limit).map((i) => this.itemRow(i, kind, t)),
        ];
        if (!shown.length) rows.push(this.empty(tab, e, t, items.length > 0));
        else if (shown.length > this.limit) rows.push(this.more(shown.length, t));
        else if (items.length >= 200) rows.push(div().px(12).py(10).text_size(11.5).text_color(t.dim).child("Showing the 200 most recent. Filter or open GitHub for the rest."));
        break;
      }
      case "actions": { const s = items.filter((r) => this.matches(`${r.displayTitle} ${r.workflowName} ${r.headBranch} #${r.number}`)); rows = s.map((r) => this.runRow(r, t)); if (!s.length) rows.push(this.empty(tab, e, t, items.length > 0)); break; }
      case "milestones": { const s = items.filter((m) => this.matches(m.title)); rows = s.map((m) => this.milestoneRow(m, t)); if (!s.length) rows.push(this.empty(tab, e, t, items.length > 0)); break; }
      case "projects": { const s = items.filter((x) => this.matches(`${x.title} ${x.owner}`)); rows = s.map((x) => this.projectRow(x, t)); if (!s.length) rows.push(this.empty(tab, e, t, items.length > 0)); break; }
      case "repos": {
        const counts = (this.counts ??= remembered("counts")).byRepo ?? {};
        const s = items.filter((r) => this.matches(`${r.nameWithOwner} ${r.description ?? ""}`));
        rows = s.slice(0, this.limit).map((r) => this.repoRow(r, t, counts)); if (!s.length) rows.push(this.empty(tab, e, t, items.length > 0)); else if (s.length > this.limit) rows.push(this.more(s.length, t)); break;
      }
    }
    return v_flex().id(`list-${tab}`).flex_1().min_h(0).overflow_y_scrollbar()
      .when(Boolean(e.error) && items.length > 0, (x) => x.child(h_flex().px(12).py(6).gap(6).items_center().bg(`${primer(t).closed}14`).text_size(11.5).text_color(primer(t).closed)
        .child(glyph("alert", 12, primer(t).closed)).child(div().flex_1().truncate().child(e.error))))
      .children(rows);
  }

  // GitHub pages its lists; drawing 200 rows at once is too slow for one frame.
  more(total, t) {
    return h_flex().flex_none().py(10).justify_center().child(button("more", `Show ${Math.min(PAGE, total - this.limit)} more · ${total - this.limit} left`, t, (_e, cx) => { this.limit += PAGE; cx.notify(); }, { small: true }));
  }
  heading(label, t) { return div().flex_none().px(14).pt(10).pb(6).text_size(12).font_semibold().text_color(t.dim).border_b(1).border_color(t.border).child(label); }

  repoBody(t, cx) {
    const repo = this.repo(), e = this.entry(), r = e.items, p = primer(t), local = this.locals[repo];
    if (!r) return e.error ? this.empty("repo", e, t, false) : skeleton(t, 4);
    const stat = (g, text) => h_flex().gap(5).items_center().child(glyph(g, 14, t.muted)).child(div().child(text));
    const section = (title, body) => v_flex().flex_none().px(14).py(12).gap(8).border_b(1).border_color(t.border).child(div().text_size(12).font_semibold().text_color(t.muted).child(title)).child(body);
    const ls = local?.branch ? local : null;
    if (local && !local.read) { local.read = true; cx.spawn(async (cx) => { await this.readLocal(repo); cx.notify(); }); }
    return v_flex().id("repo-body").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().flex_none().px(14).py(14).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().child(glyph(r.visibility === "PRIVATE" ? "lock" : "repo", 16, t.muted))
          .child(div().text_size(15).font_semibold().text_color(p.link).child(r.nameWithOwner.split("/")[1])).child(badge(r.visibility === "PRIVATE" ? "Private" : "Public", t))
          .when(r.isArchived, (x) => x.child(badge("Archived", t, p.attention))))
        .when(Boolean(r.description), (x) => x.child(div().text_size(13).text_color(t.foreground).child(r.description)))
        .when(Boolean(r.homepageUrl), (x) => x.child(h_flex().id("homepage").gap(5).items_center().text_size(12).text_color(p.link).cursor_pointer().hover((s) => s.underline()).on_click(() => openUrl(r.homepageUrl))
          .child(glyph("link", 12, p.link)).child(div().truncate().child(r.homepageUrl.replace(/^https?:\/\//, "")))))
        .when(r.repositoryTopics?.length > 0, (x) => x.child(h_flex().gap(4).flex_wrap().children(r.repositoryTopics.slice(0, 10).map((tp) => div().h(20).px(8).flex().items_center().rounded(10).bg(`${p.link}1f`).text_size(11.5).font_medium().text_color(p.link).child(tp.name)))))
        .child(h_flex().gap(14).flex_wrap().pt(4).text_size(12).text_color(t.muted)
          .child(stat("star", `${r.stargazerCount}`)).child(stat("fork", `${r.forkCount}`)).child(stat("eye", `${r.watchers?.totalCount ?? 0}`))
          .when(Boolean(r.primaryLanguage?.name), (x) => x.child(div().child(r.primaryLanguage.name)))
          .when(Boolean(r.licenseInfo?.name), (x) => x.child(div().child(r.licenseInfo.name))))
        .child(h_flex().gap(6).pt(6).flex_wrap()
          .child(button("repo-gh", "Open on GitHub", t, () => openUrl(r.url), { icon: "external", small: true }))
          .child(button("repo-clone-url", "Copy clone URL", t, (_e, cx) => copied(cx, r.sshUrl, "Clone URL copied", r.sshUrl), { icon: "copy", small: true }))))
      .child(section("This machine", local
        ? v_flex().gap(6).text_size(12.5)
          .child(h_flex().gap(6).items_center().child(glyph("folder", 13, t.muted)).child(div().flex_1().truncate().child(local.folder)))
          .when(Boolean(ls), (x) => x.child(h_flex().gap(6).items_center().child(glyph("branch", 13, t.muted))
            .child(div().font_family("JetBrains Mono").text_size(12).child(ls.branch))
            .child(div().text_color(ls.changed ? p.attention : t.muted).child(ls.changed ? `${ls.changed} uncommitted` : "clean"))
            .when(ls.ahead > 0, (y) => y.child(div().text_color(t.muted).child(`↑${ls.ahead}`))).when(ls.behind > 0, (y) => y.child(div().text_color(p.attention).child(`↓${ls.behind}`)))))
          .child(h_flex().gap(6).pt(2).child(button("repo-term", "Terminal here", t, () => run("terminal.open", { folder: local.folder, place: "tab" }), { icon: "terminal", small: true })))
        : v_flex().gap(8).child(div().text_size(12).text_color(t.muted).child("Not cloned on this machine."))
          .child(h_flex().child(button("repo-clone", "Clone with gh", t, () => this.clone(repo), { icon: "terminal", small: true, tooltip: "gh repo clone, in your first project folder" })))))
      .child(section("At a glance", v_flex().gap(2).text_size(12.5)
        .child(this.glance("glance-issues", "issue-open", p.open, `${r.issues?.totalCount ?? 0} open issues`, (_e, cx) => this.setTab("issues", cx), t))
        .child(this.glance("glance-prs", "pr-open", p.open, `${r.pullRequests?.totalCount ?? 0} open pull requests`, (_e, cx) => this.setTab("prs", cx), t))
        .child(this.glance("glance-branches", "branch", t.muted, `${r.branches?.length ?? 0} branches · default ${r.defaultBranchRef?.name ?? "?"}`, () => openUrl(`${r.url}/branches`), t))
        .child(this.glance("glance-actions", "actions", t.muted, "Workflow runs", (_e, cx) => this.setTab("actions", cx), t))))
      .child(section("Releases", r.releases?.length
        ? v_flex().gap(2).children(r.releases.map((rel) => h_flex().id(`rel-${rel.tagName}`).py(4).gap(8).items_center().text_size(12.5).cursor_pointer().hover((s) => s.text_color(p.link))
          .on_click(() => openUrl(`${r.url}/releases/tag/${rel.tagName}`))
          .child(glyph("tag", 13, rel.isLatest ? p.open : t.muted)).child(div().flex_1().truncate().font_semibold().child(rel.name || rel.tagName))
          .when(rel.isLatest, (x) => x.child(badge("Latest", t, p.open))).when(rel.isPrerelease, (x) => x.child(badge("Pre-release", t, p.attention)))
          .child(div().text_size(11.5).text_color(t.muted).child(ago(rel.publishedAt)))))
        : div().text_size(12).text_color(t.muted).child("No releases yet.")));
  }
  glance(id, g, color, label, onClick, t) {
    return h_flex().id(id).h(28).px(6).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(glyph(g, 14, color)).child(div().flex_1().child(label)).child(glyph("chevron-right", 13, t.dim));
  }

  // ---- drawing: chrome ----
  header(t) {
    const p = primer(t), repo = this.repo(), all = this.all(), pinned = Boolean(this.pin()), e = this.entry();
    const [owner, name] = all ? [null, "All repositories"] : repo ? repo.split("/") : [null, "No repository"];
    return h_flex().flex_none().h(44).px(12).gap(6).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("repo-switch").flex_1().min_w(0).h(30).px(8).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => this.openPicker())
        .child(glyph(all ? "repos" : "github", 16, t.foreground))
        .child(h_flex().min_w(0).gap(0).text_size(14.5)
          .when(Boolean(owner), (x) => x.child(div().flex_none().text_color(t.muted).child(`${owner}/`)))
          .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(name)))
        .child(glyph("chevron-down", 14, t.muted))
        .when(pinned && !all, (x) => x.child(div().flex_none().text_size(11.5).text_color(t.dim).child("pinned"))))
      .child(e.loading ? div().px(7).child(spinner(14, t.muted)) : button("refresh", "", t, (_e, cx) => this.refresh(cx), { icon: "refresh", invisible: true, tooltip: "Refresh" }))
      .when(Boolean(repo) && !all, (x) => x.child(button("new-issue", "", t, () => this.create(), { icon: "plus", invisible: true, tooltip: "New issue" }))
        .child(button("open-gh", "", t, () => openUrl(`https://github.com/${repo}${{ issues: "/issues", prs: "/pulls", actions: "/actions", milestones: "/milestones", projects: "/projects" }[this.shownTab()] ?? ""}`), { icon: "external", invisible: true, tooltip: "Open on GitHub" })));
  }

  // Pill navigation matching herdr-max controls.
  nav(t) {
    const p = primer(t), tab = this.shownTab();
    const count = (k) => k === "issues" || k === "prs" ? this.count(k) : null;
    return h_flex().id("nav").flex_none().h(42).px(8).gap(4).items_center().border_b(1).border_color(t.border)
      .children(this.tabs().map((k) => {
        const on = k === tab, n = count(k), meta = TABS[k];
        return h_flex().id(`nav-${k}`).flex_none().h(28).px(9).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(on ? t.selected : "#00000000").hover((s) => s.bg(on ? t.selected : t.hover))
          .text_size(13).text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold())
          .on_click((_e, cx) => this.setTab(k, cx)).tooltip(meta.label)
          .child(glyph(meta.icon, 15, on ? p.nav : t.muted))
          .when(on, (x) => x.child(meta.short ?? meta.label))
          .when(n !== null && n > 0, (x) => x.child(counter(n >= 200 ? "200+" : n, t, on)));
      }));
  }

  search(t) {
    return h_flex().flex_none().px(10).py(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("filter").flex_1().min_w(0).h(32).px(10).gap(7).items_center().rounded(7).bg(t.input ?? t.background).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(glyph("search", 14, t.muted)).child(Input.new(this.input).flex_1().h_full().text_size(13.5).text_color(t.foreground)));
  }

  shell(t) {
    return v_flex().id("github").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(14);
  }

  render(cx) {
    const t = theme();
    this.here = null;
    if (this.viewer) return this.viewer.render(cx);
    if (this.runView) return this.runView.render(cx);
    if (this.agentMenu) return this.agentMenu.render(cx, t);
    if (this.copying) return renderCopyMenu(this.copying.items, this.copying.overlay, t);
    if (this.picker) return this.renderPicker(t);
    if (this.form) return this.renderCreate(t);

    const away = hidden(), ctx = JSON.stringify([this.where().cwd, this.where().space]);
    if ((this.away && !away) || (!away && ctx !== this.ctx)) { this.ctx = ctx; this.refresh(cx, true); }
    this.away = away;
    const changed = shared("github.changed");
    if (changed?.at && changed.at !== this.changedAt) { this.changedAt = changed.at; this.refresh(cx, true); }
    const picked = shared("github.pick");
    if (picked?.at && picked.at !== this.pickedAt) { this.pickedAt = picked.at; this.setPin(picked.space, picked.value, cx); }

    const p = primer(t), a = this.account;
    if (!a) return this.shell(t).child(blankslate(t, { icon: "spin", title: "Connecting to GitHub…", body: "Reading your gh session." }));
    if (a.state === "missing") return this.shell(t).child(blankslate(t, { icon: "github", title: "GitHub CLI not found", body: "This panel talks to GitHub through gh. Install it, sign in, then come back.", actions: [button("install", "Install gh", t, () => openUrl("https://cli.github.com"), { icon: "external", primary: true })] }));
    if (a.state !== "ready") return this.shell(t).child(blankslate(t, { icon: "key", title: a.state === "logged_out" ? "Sign in to GitHub" : "GitHub is unreachable", body: a.state === "logged_out" ? "Run this in a terminal and follow the steps." : a.detail, code: a.state === "logged_out" ? "gh auth login" : null,
      actions: [button("login", "Run in a new tab", t, () => run("terminal.open", { argv: ["sh", "-c", 'gh auth login; exec "${SHELL:-sh}"'], place: "tab" }), { icon: "terminal" }),
        button("recheck", "Check again", t, (_e, cx) => { this.account = null; cx.spawn(async (cx) => { this.account = await account(); this.refresh(cx); cx.notify(); }); cx.notify(); }, { icon: "refresh" })] }));
    if (!this.scope()) return this.shell(t).child(this.header(t)).child(blankslate(t, { icon: "repo", title: "No GitHub repository here", body: "Focus a terminal inside a clone and its issues, pull requests and CI show up here. Or pick one yourself.",
      actions: [button("pick", "Choose a repository", t, () => this.openPicker(), { icon: "repos", primary: true }),
        button("all-repos", "All repositories", t, (_e, cx) => this.setPin(this.where().space, "all", cx), { icon: "repos" })] }));

    const tab = this.shownTab();
    if (!this.entry().at && !this.entry().loading && !this.entry().error) this.refresh(cx, true);
    return this.shell(t)
      .child(this.header(t))
      .child(this.nav(t))
      .when(tab !== "repo", (x) => x.child(this.search(t)))
      .when(Boolean(STATES[tab]) || tab === "actions", (x) => x.child(this.listHeader(tab, t)))
      .child(tab === "repo" ? this.repoBody(t, cx) : this.listBody(tab, t));
  }

  // ---- the repository picker (a popup of this mod) ----
  openPicker(at = "pointer") {
    openOverlay({ mod: "github", kind: "popup", width: 340, height: 440, at, props: { picker: { space: this.where().space, repo: this.spaceRepos[this.where().space] ?? null, pin: this.pin(), owners: this.owners() } } });
  }
  initPicker(spec, overlay, cx) {
    this.picker = { ...spec, overlay, repos: remembered("d:picker", null), q: "" };
    this.pickInput = InputState.new({ placeholder: "Find a repository…" });
    this.pickInput.on("change", (_e, cx) => { this.picker.q = this.pickInput.value(); cx.notify(); });
    this.locals = {};
    cx.spawn(async (cx) => {
      try { const got = await load.repos({ owners: spec.owners }); this.picker.repos = got; keep("d:picker", got); } catch (e) { this.picker.error = String(e?.message ?? e); }
      cx.notify();
    });
  }
  pick(value) { setShared("github.pick", { space: this.picker.space, value, at: Date.now() }); closeOverlay(this.picker.overlay); }
  renderPicker(t) {
    const p = primer(t), s = this.picker, q = s.q.trim().toLowerCase();
    const row = (id, g, title, note, on, onClick) => h_flex().id(id).h(40).flex_none().px(10).gap(10).items_center().rounded(6).cursor_pointer().hover((x) => x.bg(t.hover)).on_click(onClick)
      .child(div().w(14).flex_none().child(on ? glyph("check", 14, p.link) : div()))
      .child(glyph(g, 15, t.muted))
      .child(v_flex().flex_1().min_w(0).child(div().text_size(13).truncate().font_medium().child(title)).when(Boolean(note), (x) => x.child(div().text_size(11).text_color(t.muted).truncate().child(note))));
    const repos = (s.repos ?? []).filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q));
    return v_flex().id("picker").size_full().bg(t.popover).text_color(t.foreground)
      .child(div().px(12).pt(10).pb(8).text_size(12).font_semibold().child("Switch repository"))
      .child(h_flex().mx(10).mb(8).h(30).px(9).gap(7).items_center().rounded(6).bg(t.input ?? t.background).border_1().border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(glyph("search", 14, t.muted)).child(Input.new(this.pickInput).flex_1().h_full().text_size(12.5)))
      .child(v_flex().id("picker-list").flex_none().h(372).overflow_y_scrollbar().px(4).pb(6)
        .when(!q, (x) => x.child(row("pick-follow", "terminal", "Follow the terminal", s.repo ?? "Shows the focused terminal's repository", !s.pin, () => this.pick(null)))
          .child(row("pick-all", "repos", "All repositories", "Issues and pull requests across your accounts", s.pin === "all", () => this.pick("all")))
          .child(div().mx(10).my(6).h(1).bg(t.border)))
        .when(!s.repos && !s.error, (x) => x.child(div().px(12).py(8).text_size(12).text_color(t.muted).child("Loading repositories…")))
        .when(Boolean(s.error), (x) => x.child(div().px(12).py(8).text_size(12).text_color(p.closed).child(s.error)))
        .when(Boolean(s.repos) && !repos.length, (x) => x.child(div().px(12).py(8).text_size(12).text_color(t.muted).child(`No repository matches “${s.q.trim()}”`)))
        .children(repos.map((r) => row(`pick-${r.nameWithOwner}`, r.isPrivate ? "lock" : "repo", r.nameWithOwner, `${r.primaryLanguage?.name ? `${r.primaryLanguage.name} · ` : ""}updated ${ago(r.pushedAt)}`, s.pin === r.nameWithOwner, () => this.pick(r.nameWithOwner)))));
  }

  // Clones into the first project folder that exists (see ROOTS), else home, in a new tab.
  clone(repo) {
    const roots = [...this.roots, ...ROOTS.filter((r) => !r.startsWith("."))].map((d) => d.startsWith("/") ? d : `$HOME/${d}`);
    const script = `for d in ${roots.map((d) => `"${d}"`).join(" ")}; do [ -d "$d" ] && cd "$d" && break; done; gh repo clone "$1" && cd "$2"; exec "\${SHELL:-sh}"`;
    run("terminal.open", { argv: ["sh", "-c", script, "sh", repo, repo.split("/")[1]], place: "tab" });
  }

  // ---- new issue (a dialog of this mod) ----
  create() { openOverlay({ mod: "github", kind: "dialog", modal: true, width: 640, height: 480, props: { create: { repo: this.repo(), me: this.account?.login, locals: this.localFor(this.repo()) } } }); }
  initCreate(spec, overlay, cx) {
    this.form = { ...spec, overlay };
    this.titleInput = InputState.new({ placeholder: "Title" });
    this.bodyInput = TextareaState.new({ placeholder: "Describe the problem or the change. Markdown is supported." });
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
        setShared("github.changed", { repo: f.repo, at: Date.now() });
        closeOverlay(f.overlay);
        if (number) openOverlay({ mod: "github", kind: "dialog", width: 0.88, height: 0.92, props: { item: { kind: "issue", repo: f.repo, number, me: f.me, locals: f.locals } } });
      } catch (e) { f.error = String(e?.message ?? e); f.busy = false; cx.notify(); }
    });
  }
  renderCreate(t) {
    const p = primer(t), f = this.form, ok = Boolean(this.titleInput.value().trim());
    return v_flex().id("create").size_full().bg(t.background).text_color(t.foreground).px(24).py(18).gap(14)
      .child(h_flex().gap(8).items_center().child(glyph("issue-open", 16, p.open)).child(div().text_size(16).font_semibold().child("New issue"))
        .child(div().text_size(13).text_color(t.muted).child(`in ${f.repo}`)).child(div().flex_1())
        .child(button("create-close", "", t, () => closeOverlay(f.overlay), { icon: "close", invisible: true })))
      .child(v_flex().gap(6).child(div().text_size(12).font_semibold().child("Title"))
        .child(div().id("create-title").h(34).px(10).flex().items_center().rounded(6).bg(t.input ?? t.background).border_1().border_color(t.border).cursor_text()
          .child(Input.new(this.titleInput).w_full().h_full().text_size(14))))
      .child(v_flex().flex_1().min_h(0).gap(6).child(div().text_size(12).font_semibold().child("Description"))
        .child(div().id("create-body").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(8).rounded(6).bg(t.input ?? t.background).border_1().border_color(t.border).cursor_text()
          .child(Textarea.new(this.bodyInput).w_full().text_size(13.5))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(f.error ? p.closed : t.muted).child(f.error ?? "Tip: a clear expected behavior makes the agent brief much better."))
        .child(button("create-cancel", "Cancel", t, () => closeOverlay(f.overlay)))
        .child(button("create-submit", f.busy ? "Creating…" : "Create issue", t, (_e, cx) => this.submit(cx), { primary: true, enabled: ok && !f.busy })));
  }
}
