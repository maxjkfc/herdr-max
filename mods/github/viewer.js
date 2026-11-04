import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { theme, closeOverlay, setShared, run, notify } from "herdr";
import { split, want, avatar } from "./media.js";
import { entries, tally, loginOf } from "./timeline.js";
import { primer, glyph, spinner, ago, openUrl, issueState, prState, checksOf, runState, glyphOf, labelChip, button, badge, segmented } from "./ui.js";
import { ghJson, gh, localState } from "./gh.js";
import { issueBrief, prBrief } from "./brief.js";
import { copied, pickAgent, copyMenu, openIssueWorktree } from "./actions.js";

const FIELDS = {
  issue: "number,title,body,author,state,stateReason,labels,assignees,createdAt,updatedAt,comments,url,milestone,closedByPullRequestsReferences,reactionGroups",
  pr: "number,title,body,author,state,isDraft,labels,assignees,createdAt,updatedAt,comments,url,milestone,reactionGroups,headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,mergeable,reviewRequests,reviews,closingIssuesReferences,mergedAt",
};
const LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/;
const ROLE = { OWNER: "Owner", MEMBER: "Member", COLLABORATOR: "Collaborator", CONTRIBUTOR: "Contributor" };
const VERDICT = { APPROVED: ["check-circle", "open", "approved these changes"], CHANGES_REQUESTED: ["x-circle", "closed", "requested changes"], COMMENTED: ["comment", null, "reviewed"], DISMISSED: ["skip", null, "had a review dismissed"] };
const METHODS = [["merge", "Merge commit"], ["squash", "Squash and merge"], ["rebase", "Rebase and merge"]];
const MONO = "JetBrains Mono";
const MAX_DIFF_ROWS = 5000;

const display = (name) => name.replace(/^app\//, "").replace(/\[bot\]$/, "");
const isBot = (name) => /^app\/|\[bot\]$/.test(name);
const upper = (s) => String(s ?? "").toUpperCase();

// #12 and owner/repo#12 outside code become links the viewer opens itself.
function linkRefs(md, repo) {
  return md.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, n) => n % 2 ? part
    : part.replace(/(^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g, (_m, pre, other, num) => `${pre}[${other ?? ""}#${num}](https://github.com/${other ?? repo}/issues/${num})`)).join("");
}

export function parseDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const head = /^a\/(.*) b\/(.*)$/.exec(lines[0]);
    let path = head ? head[2] : lines[0];
    const file = { path, add: 0, del: 0, binary: false, rows: [] };
    let old = 0, next = 0, inHunk = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!inHunk) {
        if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) file.binary = true;
        if (line.startsWith("+++ b/")) file.path = line.slice(6);
        else if (line.startsWith("--- a/") && lines[i + 1] === "+++ /dev/null") file.path = line.slice(6);
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { inHunk = true; old = Number(m[1]); next = Number(m[2]); file.rows.push({ kind: "@", text: line }); continue; }
      if (!inHunk) continue;
      if (line.startsWith("+")) { file.add++; file.rows.push({ kind: "+", number: next++, text: line.slice(1) }); }
      else if (line.startsWith("-")) { file.del++; file.rows.push({ kind: "-", number: old++, text: line.slice(1) }); }
      else if (line.startsWith("\\")) file.rows.push({ kind: "@", text: line });
      else if (i < lines.length - 1 || line !== "") { file.rows.push({ kind: " ", number: next++, text: line.slice(1) }); old++; }
    }
    files.push(file);
  }
  return files;
}

// One issue or pull request in a dialog: { kind, repo, number, data?, me?, locals? } from the panel.
export class Viewer {
  constructor({ kind, repo, number, data, me, locals }, overlay, cx) {
    Object.assign(this, { kind, repo, number, me, overlay, locals: locals ?? {} });
    this.trail = []; this.items = {}; this.threads = {}; this.repoLabels = {}; this.mode = "write";
    this.subTab = "conversation"; this.diffs = {}; this.fileIdx = 0; this.diffRows = []; this.diffWidth = 0;
    this.mergeOpen = false; this.merging = false; this.mergeError = null;
    if (data) this.items[this.key()] = data;
    this.box = TextareaState.new({ placeholder: "Leave a comment (Markdown)" });
    this.box.set_auto_grow(4, 14);
    this.box.on("change", (_e, cx) => { const any = Boolean(this.box.value().trim()); if (any !== this.typed) { this.typed = any; cx.notify(); } });
    this.box.on("submit", (e, cx) => { if (e.secondary) this.comment(cx); });
    this.load(cx);
  }

  key() { return `${this.repo}#${this.number}`; }
  pr() { return this.kind === "pr"; }
  local() { return this.locals[this.repo] ?? null; }
  open() { return upper(this.item?.state) === "OPEN"; }

  // Item and timeline together; a stale answer (the person followed a link meanwhile) is dropped.
  load(cx) {
    const key = this.key(), kind = this.kind, still = () => this.key() === key;
    this.item = this.items[key] ?? null; this.error = null; this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [item, pages] = await Promise.all([
          ghJson([kind, "view", String(this.number), "-R", this.repo, "--json", FIELDS[kind]]),
          ghJson(["api", "--paginate", "--slurp", `repos/${this.repo}/issues/${this.number}/timeline?per_page=100`]).catch(() => null),
        ]);
        if (kind === "issue" && item.url.includes("/pull/")) { this.kind = "pr"; return this.load(cx); } // #12 can be a pull request
        Object.assign(item, { repo: this.repo }, kind === "pr" ? { checks: checksOf(item) } : {});
        this.items[key] = item;
        if (pages) this.threads[key] = entries(pages.flat());
        if (still()) this.item = item;
        if (this.local()?.folder) this.localState = await localState(this.local().folder);
        if (still() && this.pr() && this.subTab === "files") this.loadDiff(cx, true);
      } catch (e) { if (still()) this.error = String(e?.message ?? e); }
      finally { if (still()) { this.loading = false; cx.notify(); } }
    });
  }

  loadDiff(cx, force = false) {
    const key = this.key();
    if (!force && this.diffs[key]) {
      this.pickDiffFile(this.fileIdx);
      return;
    }
    this.diffLoading = true; this.diffError = null;
    cx.spawn(async (cx) => {
      try {
        const raw = await gh(["pr", "diff", String(this.number), "-R", this.repo]);
        if (this.key() !== key) return;
        this.diffs[key] = parseDiff(raw);
        this.pickDiffFile(0);
      } catch (e) {
        if (this.key() === key) this.diffError = String(e?.message ?? e);
      } finally {
        if (this.key() === key) { this.diffLoading = false; cx.notify(); }
      }
    });
    cx.notify();
  }

  pickDiffFile(idx) {
    const files = this.diffs[this.key()] ?? [];
    this.fileIdx = Math.max(0, Math.min(idx, files.length - 1));
    const rows = files[this.fileIdx]?.rows ?? [];
    this.diffRows = rows.length > MAX_DIFF_ROWS
      ? [...rows.slice(0, MAX_DIFF_ROWS), { kind: "@", text: `Diff truncated at ${MAX_DIFF_ROWS} lines` }]
      : rows;
    let longest = 0;
    for (const r of this.diffRows) if (r.text.length > longest) longest = r.text.length;
    this.diffWidth = Math.min(longest, 400) * 8 + 100;
  }

  setSubTab(tab, cx) {
    this.subTab = tab;
    if (tab === "files") this.loadDiff(cx);
    cx.notify();
  }

  mergePr(method, cx) {
    if (this.merging || !this.item) return;
    const key = this.key(), repo = this.repo, number = this.number, title = this.item.title, sha = this.item.headRefOid;
    this.merging = true; this.mergeError = null;
    cx.spawn(async (cx) => {
      try {
        const args = ["pr", "merge", String(number), "-R", repo, `--${method}`];
        if (sha) args.push("--match-head-commit", sha);
        await gh(args);
        notify({ title: `PR #${number} merged`, body: title, level: "success", timeout: 3000 });
        setShared("github.changed", { repo, at: Date.now() });
        if (this.key() === key) { this.mergeOpen = false; this.load(cx); }
      } catch (e) {
        if (this.key() === key) this.mergeError = String(e?.message ?? e);
      } finally {
        this.merging = false; cx.notify();
      }
    });
    cx.notify();
  }

  goTo(repo, number, kind, cx) {
    if (repo === this.repo && number === this.number) return;
    this.trail.push({ repo: this.repo, number: this.number, kind: this.kind });
    Object.assign(this, { repo, number, kind, picking: false, subTab: "conversation", mergeOpen: false, mergeError: null });
    this.load(cx); cx.notify();
  }
  goBack(cx) {
    const prev = this.trail.pop();
    if (prev) { Object.assign(this, prev, { picking: false, subTab: "conversation", mergeOpen: false, mergeError: null }); this.load(cx); cx.notify(); }
  }
  follow(url, cx) {
    const m = LINK.exec(url);
    if (m) this.goTo(m[1], Number(m[3]), m[2] === "pull" ? "pr" : "issue", cx); else openUrl(url);
  }

  // Runs `gh <issue|pr> <verb> N …`, then reloads and tells the panel to refresh.
  act(doing, verb, extra, cx, done) {
    if (this.busy) return;
    const repo = this.repo, number = this.number, key = this.key();
    this.busy = doing; this.error = null;
    cx.spawn(async (cx) => {
      try { await gh([this.kind, verb, String(number), "-R", repo, ...extra]); done?.(); }
      catch (e) { this.error = String(e?.message ?? e); }
      finally {
        this.busy = null;
        setShared("github.changed", { repo, at: Date.now() });
        if (this.key() === key) this.load(cx);
        cx.notify();
      }
    });
    cx.notify();
  }
  typedText() { return this.box.value().trim(); }
  clearBox() { this.box.set_value(""); this.typed = false; this.mode = "write"; }
  comment(cx) { if (this.typedText()) this.act("Commenting", "comment", ["--body", this.typedText()], cx, () => this.clearBox()); }
  close(reason, cx) {
    const extra = [...(this.pr() ? [] : ["--reason", reason]), ...(this.typedText() ? ["--comment", this.typedText()] : [])];
    this.act("Closing", "close", extra, cx, () => this.clearBox());
  }
  reopen(cx) { this.act("Reopening", "reopen", this.typedText() ? ["--comment", this.typedText()] : [], cx, () => this.clearBox()); }
  flipLabel(label, cx) {
    const on = this.item.labels.some((l) => l.name === label.name);
    this.item.labels = on ? this.item.labels.filter((l) => l.name !== label.name) : [...this.item.labels, label]; // shown at once, confirmed by the reload
    this.act("Saving labels", "edit", [on ? "--remove-label" : "--add-label", label.name], cx);
  }
  pickLabels(cx) {
    this.picking = !this.picking;
    const repo = this.repo;
    if (this.picking && !this.repoLabels[repo]) cx.spawn(async (cx) => {
      const all = await ghJson(["label", "list", "-R", repo, "--limit", "200", "--json", "name,color,description"]).catch(() => []);
      this.repoLabels[repo] = all.sort((a, b) => a.name.localeCompare(b.name));
      cx.notify();
    });
    cx.notify();
  }

  brief() {
    const local = this.local() ? { ...this.local(), ...this.localState } : null;
    return this.pr() ? prBrief(this.item, { local }) : issueBrief(this.item, { local });
  }
  startAgent() {
    const local = this.local();
    pickAgent({
      name: `${this.pr() ? "PR " : ""}#${this.number} ${this.repo.split("/")[1]}`,
      brief: this.brief(),
      folder: local?.folder ?? null,
      space: local?.space ?? null,
      issue: !this.pr() && this.item ? { number: this.number, title: this.item.title } : null,
    });
  }
  openWorktree() {
    if (!this.item) return;
    const local = this.local();
    openIssueWorktree({
      issue: { number: this.number, title: this.item.title },
      folder: local?.folder ?? null,
      space: local?.space ?? null,
    })
      .then(() => closeOverlay(this.overlay))
      .catch((e) => notify({ title: "Worktree failed", body: String(e?.message ?? e), level: "error" }));
  }
  checkout() {
    const folder = this.local()?.folder;
    run("terminal.open", { argv: ["sh", "-c", `gh pr checkout ${this.number} && exec "\${SHELL:-sh}"`], ...(folder ? { folder } : {}), place: "tab" });
    closeOverlay(this.overlay);
  }

  // ---- pieces ----
  // Redraws once a download started by this render settles.
  waitFor(pending, cx) { if (pending) cx.spawn(async (cx) => { await pending; cx.notify(); }); }

  face(login, url, size, t, cx) {
    const { got, pending } = avatar(login, url);
    this.waitFor(pending, cx);
    if (got?.path) return image(got.path).size(size).flex_none().rounded(size / 2);
    const hues = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6], tint = hues[(login.length * 7 + login.charCodeAt(0)) % hues.length];
    return div().size(size).flex_none().rounded(size / 2).bg(`${tint}33`).text_color(tint).font_semibold().text_size(Math.round(size / 2))
      .flex().items_center().justify_center().child(display(login).charAt(0).toUpperCase());
  }

  // Markdown with its pictures drawn between the text runs.
  prose(key, body, t, cx) {
    return v_flex().gap(12).children(split(body).map((part, n) => part.image ? this.shot(`${key}-${n}`, part, t, cx)
      : TextView.markdown(`${key}-${n}`, linkRefs(part.text, this.repo)).selectable(true).on_link_click((url, cx) => this.follow(url, cx))));
  }

  shot(key, part, t, cx) {
    const { got, pending } = want(part.image);
    this.waitFor(pending, cx);
    if (!got?.path) {
      const lost = got === "missing";
      return h_flex().id(key).h(lost ? 36 : 120).w_full().flex_none().px(12).gap(8).items_center().justify_center().rounded(6).border_1().border_color(t.border).bg(t.raised)
        .text_size(12).text_color(t.muted).cursor_pointer().on_click(() => openUrl(part.image))
        .child(lost ? glyph("image", 14, t.muted) : spinner(14, t.muted))
        .child(div().min_w(0).truncate().child(lost ? `Couldn't show this image${part.alt ? ` (${part.alt})` : ""} · open it` : "Loading image…"));
    }
    const fit = Math.max(200, (this.column ?? 760) - 34), w = Math.min(part.width ?? got.width, got.width, fit);
    return div().id(key).flex_none().cursor_pointer().on_click(() => openUrl(got.file)).child(image(got.path).w(w).h(Math.round(got.height * w / got.width)).rounded(6));
  }

  // A comment or review: avatar, who, when, roles, the text, its reactions.
  card(key, c, t, cx) {
    const p = primer(t), verdict = c.review ? VERDICT[c.review] : null, author = loginOf(this.item.author);
    const head = h_flex().h(38).px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(13)
      .child(this.face(c.who, c.avatar, 20, t, cx))
      .child(div().font_semibold().child(display(c.who)))
      .when(isBot(c.who), (e) => e.child(badge("bot", t)))
      .when(Boolean(verdict), (e) => e.child(glyph(verdict[0], 14, verdict[1] ? p[verdict[1]] : t.muted)).child(div().text_color(t.muted).child(verdict[2])))
      .child(div().text_color(t.muted).child(c.opening ? `opened ${ago(c.at)}` : ago(c.at)))
      .child(div().flex_1())
      .when(!c.opening && c.who === author, (e) => e.child(badge("Author", t)))
      .when(!c.opening && Boolean(ROLE[c.role]), (e) => e.child(badge(ROLE[c.role], t)));
    const text = c.body?.trim();
    return v_flex().flex_none().rounded(6).overflow_hidden().bg(t.background).border_1().border_color(c.review === "CHANGES_REQUESTED" ? `${p.closed}88` : t.border)
      .child(head)
      .when(Boolean(text) || c.opening, (e) => e.child(div().px(16).py(14).text_size(14)
        .child(text ? this.prose(key, text, t, cx) : div().italic().text_color(t.muted).child("No description provided."))))
      .when(c.reactions?.length > 0, (e) => e.child(h_flex().px(16).pb(12).gap(6).flex_wrap()
        .children(c.reactions.map((r) => div().h(24).px(8).flex().items_center().rounded(12).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(r)))));
  }

  // An event as an icon and a line of words; words are text, { b } bold, { label }, { code } or { struck }.
  line(e, t) {
    const p = primer(t), pr = this.pr();
    if (e.labels) {
      const { added, removed } = e.labels;
      return ["tag", null, [...(added.length ? ["added", ...added.map((label) => ({ label }))] : []), ...(added.length && removed.length ? ["and"] : []),
        ...(removed.length ? ["removed", ...removed.map((label) => ({ label }))] : []), added.length + removed.length > 1 ? "labels" : "label"]];
    }
    if (e.assigned) return ["user", null, e.assigned === e.who ? ["self-assigned this"] : ["assigned", { b: display(e.assigned) }]];
    if (e.unassigned) return ["user", null, e.unassigned === e.who ? ["removed their assignment"] : ["unassigned", { b: display(e.unassigned) }]];
    if (e.closed) return e.closed === "not_planned" ? ["issue-skip", p.neutral, ["closed this as not planned"]]
      : [pr ? "pr-closed" : "issue-done", pr ? p.closed : p.done, [pr ? "closed this" : "closed this as completed"]];
    if (e.reopened) return [pr ? "pr-open" : "issue-open", p.open, ["reopened this"]];
    if (e.merged) return ["pr-merged", p.done, ["merged commit", { code: e.merged.sha }]];
    if (e.renamed) return ["pencil", null, ["changed the title", { struck: e.renamed.from }, { b: e.renamed.to }]];
    if (e.milestone) return ["milestone", null, [e.milestone.added ? "added this to the" : "removed this from the", { b: e.milestone.title }, "milestone"]];
    if (e.mention) return ["link", null, ["mentioned this"]];
    if (e.commit) return ["commit", null, [e.commit.message ? "committed" : "added a commit that references this"]];
    return ["dot", null, []];
  }

  event(key, e, t, cx) {
    const p = primer(t), [icon, fill, words] = this.line(e, t);
    const word = (w) => typeof w === "string" ? div().child(w) : w.b !== undefined ? div().font_semibold().text_color(t.foreground).child(w.b)
      : w.label ? labelChip(w.label, t, true) : w.code ? div().font_family(MONO).text_size(12).child(w.code) : div().line_through().child(w.struck ?? "");
    const target = e.mention ?? (e.commit?.url ? e.commit : null);
    const badgeIcon = h_flex().size(28).flex_none().justify_center().items_center().rounded(14).border_1()
      .bg(fill ?? t.raised).border_color(fill ?? t.border).child(glyph(icon, 14, fill ? "#ffffff" : t.muted));
    return v_flex().flex_none().gap(6)
      .child(h_flex().pl(6).gap(10).items_center().child(badgeIcon)
        .child(h_flex().flex_1().min_w(0).gap(5).flex_wrap().items_center().text_size(13).text_color(t.muted)
          .when(!e.commit, (x) => x.child(this.face(e.who, e.avatar, 16, t, cx)))
          .child(div().font_semibold().text_color(t.foreground).child(display(e.who)))
          .children(words.map(word))
          .child(div().child(ago(e.at)))))
      .when(Boolean(target), (x) => x.child(h_flex().id(key).ml(44).gap(8).items_center().cursor_pointer().text_size(e.commit ? 12 : 13)
        .on_click((_ev, cx) => this.follow(target.url, cx))
        .when(Boolean(e.mention), (y) => y.child(glyph(e.mention.pr ? (e.mention.merged ? "pr-merged" : "pr-open") : "issue-open", 16, e.mention.open ? p.open : e.mention.merged || !e.mention.open ? p.done : t.muted))
          .child(div().font_semibold().text_color(t.foreground).hover((s) => s.text_color(p.link)).child(e.mention.title ?? ""))
          .child(div().text_color(t.muted).child(`${e.mention.repo === this.repo ? "" : e.mention.repo ?? ""}#${e.mention.number}`)))
        .when(Boolean(e.commit), (y) => y.when(Boolean(e.commit.message), (z) => z.child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(e.commit.message)))
          .child(div().px(6).py(1).rounded(5).bg(t.raised).border_1().border_color(t.border).font_family(MONO).text_color(t.muted).hover((s) => s.text_color(p.link)).child(e.commit.sha)))));
  }

  // The opening post, then the timeline (or, before it loads, the comments gh returned).
  conversation(i, t, cx) {
    const thread = this.threads[this.key()]
      ?? (i.comments ?? []).map((c) => ({ card: "comment", who: loginOf(c.author), at: c.createdAt, body: c.body, role: c.authorAssociation, reactions: tally(c.reactionGroups) }));
    const opening = { card: "comment", opening: true, who: loginOf(i.author), at: i.createdAt, body: i.body, reactions: tally(i.reactionGroups) };
    const rail = () => div().flex_none().ml(19).w(2).h(16).bg(t.border);
    return [this.card("opening", opening, t, cx), ...thread.flatMap((e, n) => [rail(), e.card ? this.card(`c${n}`, e, t, cx) : this.event(`e${n}`, e, t, cx)])];
  }

  // Above the comment box on an open pull request: checks, review, conflicts, and direct Merge controls.
  mergeBox(i, t, cx) {
    const p = primer(t), c = i.checks ?? checksOf(i);
    const row = (icon, color, title, note, extra = null) => h_flex().px(16).py(12).gap(12).items_start().border_b(1).border_color(t.border)
      .child(div().pt(1).child(glyphOf(icon, 18, color, t)))
      .child(v_flex().flex_1().gap(4).child(div().text_size(14).font_semibold().child(title)).when(Boolean(note), (e) => e.child(div().text_size(12).text_color(t.muted).child(note))).when(Boolean(extra), (e) => e.child(extra)));
    const review = { APPROVED: ["check-circle", p.open, "Changes approved"], CHANGES_REQUESTED: ["x-circle", "closed", "Changes requested"], REVIEW_REQUIRED: ["dot", p.attention, "Review required"] }[i.reviewDecision];
    const checks = { failure: ["x-circle", p.closed, "Some checks were not successful"], pending: ["spin", p.attention, "Some checks haven't completed yet"], success: ["check-circle", p.open, "All checks have passed"] }[c.state];
    const conflict = i.mergeable === "CONFLICTING";
    const blocked = i.isDraft
      ? "Draft pull request"
      : conflict
      ? "Has merge conflicts"
      : c.state === "failure"
      ? "Checks failing"
      : c.state === "pending"
      ? "Checks in progress"
      : null;
    const controls = v_flex().gap(8).pt(4)
      .child(h_flex().gap(8).items_center()
        .child(button("pr-merge-toggle", this.mergeOpen ? "Cancel" : "Merge pull request…", t, (_e, cx) => { this.mergeOpen = !this.mergeOpen; this.mergeError = null; cx.notify(); },
          { primary: !this.mergeOpen, enabled: !blocked && !this.merging, icon: "pr-merged" }))
        .child(button("pr-view-diff", `View diff (${i.changedFiles ?? 0} files)`, t, (_e, cx) => this.setSubTab("files", cx), { icon: "diff" }))
        .when(Boolean(blocked), (e) => e.child(div().text_size(12).text_color(p.attention).child(blocked)))
        .when(this.merging, (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.working)).child("Merging…"))))
      .when(this.mergeOpen && !blocked, (e) => e.child(v_flex().gap(6).p(10).rounded(6).bg(t.raised).border_1().border_color(t.border)
        .child(div().text_size(12).text_color(t.muted).child(`Confirm merge of #${i.number} (${i.headRefName} → ${i.baseRefName}):`))
        .child(h_flex().gap(8).flex_wrap().children(METHODS.map(([m, label]) =>
          button(`pr-merge-${m}`, label, t, (_e, cx) => this.mergePr(m, cx), { primary: m === "squash", enabled: !this.merging }))))))
      .when(Boolean(this.mergeError), (e) => e.child(div().text_size(12).text_color(p.closed).child(this.mergeError)));

    return v_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .when(Boolean(checks), (e) => e.child(row(...checks, `${c.failed.length} failing, ${c.pending.length} in progress, ${c.runs.length - c.failed.length - c.pending.length} successful`)))
      .when(Boolean(review), (e) => e.child(row(review[0], review[1] === "closed" ? p.closed : review[1], review[2], null)))
      .child(row(i.isDraft ? "pr-draft" : conflict ? "alert" : "pr-open", i.isDraft ? p.neutral : conflict ? p.closed : p.open,
        i.isDraft ? "This pull request is still a draft" : conflict ? "This branch has conflicts that must be resolved" : "No conflicts with the base branch",
        blocked ? `Cannot merge yet: ${blocked}.` : "Choose a merge method below to merge directly from Herdr.",
        controls));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(14).h(22).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(22).flex_none().gap(12)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18"))
      .when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(44).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  filesTab(i, t, cx) {
    const p = primer(t), files = this.diffs[this.key()] ?? [];
    if (this.diffLoading && !files.length) {
      return v_flex().flex_1().p(32).gap(10).items_center().justify_center().text_color(t.muted)
        .child(spinner(18, t.working)).child("Loading pull request diff…");
    }
    if (this.diffError) {
      return v_flex().flex_1().p(32).gap(10).text_color(p.closed).child(this.diffError);
    }
    return h_flex().flex_1().min_h(0)
      .child(v_flex().id("pr-diff-files").w(280).flex_none().h_full().overflow_y_scrollbar().p(8).gap(2).border_r(1).border_color(t.border)
        .child(div().px(8).py(6).text_size(12).font_semibold().text_color(t.muted).child(`${files.length} changed files`))
        .children(files.map((f, idx) => h_flex().id(`pr-df-${idx}`).h(28).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(this.fileIdx === idx ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.pickDiffFile(idx); cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().text_size(13).child(f.path))
          .when(f.binary, (e) => e.child(div().text_size(11).text_color(t.dim).child("bin")))
          .when(f.add > 0, (e) => e.child(div().text_size(11.5).text_color(p.open).child(`+${f.add}`)))
          .when(f.del > 0, (e) => e.child(div().text_size(11.5).text_color(p.closed).child(`−${f.del}`))))))
      .child(div().flex_1().min_w(0).h_full().relative().font_family(MONO).text_size(13)
        .child(div().id("pr-diff-scroll-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(
            v_virtual_list("pr-diff-rows", this.diffRows.length, 22, (idx) => String(idx),
              (range) => this.diffRows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("pr-diff-rows").viewport_from_layout().absolute().inset_0()));
  }

  // Write or preview, then close/reopen and comment.
  composer(i, t, cx) {
    const p = primer(t), busy = Boolean(this.busy), pr = this.pr(), open = this.open(), noun = pr ? "pull request" : "issue";
    const body = this.mode === "write"
      ? div().id("box").px(12).py(10).cursor_text().child(Textarea.new(this.box).w_full().text_size(14).text_color(t.foreground))
      : div().px(16).py(14).min_h(110).text_size(14).child(this.typed
        ? TextView.markdown("preview", linkRefs(this.box.value(), this.repo)).on_link_click((url, cx) => this.follow(url, cx))
        : div().text_color(t.muted).child("Nothing to preview"));
    const actions = upper(i.state) === "MERGED" ? [] : open
      ? [button("close", this.typed ? "Close with comment" : `Close ${noun}`, t, (_e, cx) => this.close("completed", cx), { enabled: !busy, icon: pr ? "pr-closed" : "issue-done", tint: pr ? p.closed : p.done }),
        ...(pr ? [] : [button("not-planned", "", t, (_e, cx) => this.close("not planned", cx), { enabled: !busy, icon: "issue-skip", tint: p.neutral, tooltip: "Close as not planned" })])]
      : [button("reopen", this.typed ? "Reopen with comment" : `Reopen ${noun}`, t, (_e, cx) => this.reopen(cx), { enabled: !busy, icon: pr ? "pr-open" : "issue-open", tint: p.open })];
    return v_flex().flex_none().gap(10)
      .child(h_flex().items_center().child(div().flex_1().text_size(16).font_semibold().child("Add a comment"))
        .child(segmented("mode", [["write", "Write"], ["preview", "Preview"]], this.mode, t, (mode, cx) => { this.mode = mode; cx.notify(); })))
      .child(v_flex().rounded(6).border_1().border_color(t.border).overflow_hidden().bg(t.background)
        .child(body)
        .child(h_flex().px(12).py(10).gap(8).items_center().border_t(1).border_color(t.border)
          .child(div().flex_1().text_size(12).text_color(t.muted).child("Ctrl+Enter to comment"))
          .children(actions)
          .child(button("comment", "Comment", t, (_e, cx) => this.comment(cx), { primary: true, enabled: this.typed && !busy }))));
  }

  // The right column: who, what, where.
  aside(i, t, cx) {
    const p = primer(t), pr = this.pr(), me = this.me, local = this.local(), ls = this.localState;
    const quiet = (text) => div().text_size(12).text_color(t.muted).child(text);
    const link = (id, label, onClick) => div().id(id).text_size(12).text_color(p.link).cursor_pointer().hover((s) => s.underline()).on_click(onClick).child(label);
    const part = (title, body, extra = null) => v_flex().flex_none().gap(8).py(14).border_b(1).border_color(t.border)
      .child(h_flex().items_center().text_size(12).font_semibold().text_color(t.muted).child(div().flex_1().child(title)).when(Boolean(extra), (e) => e.child(extra)))
      .child(body);
    const person = (login) => h_flex().gap(8).items_center().text_size(13).child(this.face(login, null, 20, t, cx)).child(div().flex_1().min_w(0).truncate().font_semibold().child(display(login)));

    const reviewers = new Map((i.reviews ?? []).map((r) => [loginOf(r.author), r.state]));
    for (const r of i.reviewRequests ?? []) if (r.login && !reviewers.has(r.login)) reviewers.set(r.login, "PENDING");
    const verdictIcon = (s) => s === "APPROVED" ? glyph("check", 14, p.open) : s === "CHANGES_REQUESTED" ? glyph("x-circle", 14, p.closed) : s === "PENDING" ? glyph("dot", 14, p.attention) : glyph("comment", 14, t.muted);

    const seen = new Map([[loginOf(i.author), null]]);
    for (const e of this.threads[this.key()] ?? (i.comments ?? []).map((c) => ({ who: loginOf(c.author) }))) if (!e.commit && !seen.has(e.who)) seen.set(e.who, e.avatar ?? null);
    const people = [...seen].filter(([login]) => !isBot(login));

    const mine = i.assignees.some((a) => a.login === me), labels = this.repoLabels[this.repo];
    const linked = pr ? i.closingIssuesReferences ?? [] : i.closedByPullRequestsReferences ?? [];
    return v_flex().id("aside").w(268).flex_none().min_h(0).overflow_y_scrollbar().pl(8).pr(24).pt(6)
      .when(pr, (e) => e.child(part("Reviewers", reviewers.size ? v_flex().gap(8).children([...reviewers].map(([login, state]) => person(login).child(verdictIcon(state)))) : quiet("No reviews"))))
      .when(pr && (i.checks?.runs.length ?? 0) > 0, (e) => e.child(part("Checks", v_flex().gap(4).children(i.checks.runs.slice(0, 14).map((c, n) => {
        const [icon, color] = runState(c, p);
        return h_flex().id(`check-${n}`).gap(8).items_center().text_size(12).cursor_pointer().hover((s) => s.text_color(p.link)).on_click(() => c.url && openUrl(c.url))
          .child(glyphOf(icon, 14, color, t)).child(div().flex_1().min_w(0).truncate().child(`${c.workflow ? `${c.workflow} / ` : ""}${c.name}`));
      })))))
      .child(part("Assignees",
        i.assignees.length ? v_flex().gap(8).children(i.assignees.map((a) => person(a.login)))
          : h_flex().gap(4).child(quiet("No one")).when(Boolean(me), (e) => e.child(quiet("·")).child(link("assign", "Assign yourself", (_e, cx) => this.act("Assigning", "edit", ["--add-assignee", "@me"], cx)))),
        mine ? link("unassign", "Unassign me", (_e, cx) => this.act("Unassigning", "edit", ["--remove-assignee", "@me"], cx)) : null))
      .child(part("Labels",
        // Picking: every label of the repository as a chip, the issue's in full color; a click flips one.
        this.picking ? (!labels ? quiet("Loading labels…") : !labels.length ? quiet("This repository has no labels") : h_flex().gap(4).flex_wrap().children(labels.map((l) => {
          const on = i.labels.some((x) => x.name === l.name);
          return div().id(`label-${l.name}`).cursor_pointer().when(!on, (e) => e.opacity(0.45)).hover((s) => s.opacity(1)).when(Boolean(l.description), (e) => e.tooltip(l.description))
            .on_click((_e, cx) => this.flipLabel(l, cx)).child(labelChip(l, t));
        })))
          : i.labels.length ? h_flex().gap(4).flex_wrap().children(i.labels.map((l) => labelChip(l, t))) : quiet("No labels"),
        link("labels", this.picking ? "Done" : "Edit", (_e, cx) => this.pickLabels(cx))))
      .child(part("Milestone", i.milestone?.title ? h_flex().gap(6).items_center().text_size(13).font_semibold().child(glyph("milestone", 14, t.muted)).child(i.milestone.title) : quiet("No milestone")))
      .child(part("Development", linked.length ? v_flex().gap(8).children(linked.map((x) => h_flex().id(`dev-${x.number}`).gap(8).items_start().cursor_pointer().text_size(13)
        .on_click((_e, cx) => this.follow(x.url, cx))
        .child(div().pt(1).child(glyph(pr ? "issue-open" : "pr-merged", 14, pr ? p.open : p.done)))
        .child(v_flex().child(div().font_semibold().hover((s) => s.text_color(p.link)).child(`#${x.number}`))
          .child(div().text_size(12).text_color(t.muted).child(`${x.repository?.owner?.login ?? ""}/${x.repository?.name ?? ""}`)))))
        : quiet(pr ? "No linked issues" : "No branches or pull requests")))
      .child(part("This machine", local ? v_flex().gap(4).text_size(12)
        .child(h_flex().gap(6).items_center().child(glyph("folder", 12, t.muted)).child(div().truncate().child(local.folder)))
        .when(Boolean(ls), (e) => e.child(h_flex().gap(6).items_center().text_color(t.muted).child(glyph("branch", 12, t.muted))
          .child(div().truncate().child([ls.branch, ls.changed && `${ls.changed} changed`, ls.ahead && `↑${ls.ahead}`, ls.behind && `↓${ls.behind}`].filter(Boolean).join(" · ")))))
        : quiet("Not cloned here")))
      .child(part("Participants", h_flex().gap(4).flex_wrap().children(people.slice(0, 18).map(([login, url]) => div().tooltip(display(login)).child(this.face(login, url, 24, t, cx))))));
  }

  toolbar(i, t) {
    const p = primer(t), pr = this.pr();
    return h_flex().h(32).gap(8).items_center()
      .when(this.trail.length > 0, (e) => e.child(button("back", "Back", t, (_e, cx) => this.goBack(cx), { icon: "back" })))
      .child(glyph("repo", 14, t.muted)).child(div().text_size(13).text_color(t.muted).child(`${this.repo} #${this.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(p.closed).child(i && this.error ? this.error : ""))
      .when(this.loading || Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.working)).child(this.busy ?? "Refreshing")))
      .when(Boolean(i) && !this.loading && !this.busy, (e) => e.child(button("refresh", "", t, (_e, cx) => { this.load(cx); cx.notify(); }, { icon: "refresh", tooltip: "Refresh" })))
      .when(Boolean(i), (e) => e
        .child(button("copy", "", t, () => copyMenu([["Copy link", i.url], ["Copy reference", `${this.repo}#${i.number}`], ["Copy number and title", `#${i.number} ${i.title}`]]), { icon: "copy", tooltip: "Copy link or reference" }))
        .child(button("github", "", t, () => openUrl(i.url), { icon: "external", tooltip: "Open on GitHub" }))
        .when(!pr, (x) => x.child(button("open-wt", "Open Worktree", t, () => this.openWorktree(), { icon: "branch", tooltip: "Create/switch to worktree & bind this Issue in spaces-plus" })))
        .when(pr && this.open(), (x) => x.child(button("checkout", "Checkout", t, () => this.checkout(), { icon: "terminal", tooltip: "gh pr checkout in a new tab" })))
        .child(button("brief", "Copy brief", t, (_e, cx) => copied(cx, this.brief(), "Brief copied", `${this.repo}#${i.number} · ready to paste into an agent`), { icon: "brief" }))
        .child(button("agent", "Start agent", t, () => this.startAgent(), { primary: true, icon: "agent" })))
      .child(button("close-dialog", "", t, () => closeOverlay(this.overlay), { icon: "close", invisible: true, tooltip: "Close (Esc)" }));
  }

  // Under the title: the state pill, then who opened it, or what a pull request merges where.
  byline(i, t, cx) {
    const p = primer(t), pr = this.pr(), [icon, color, state] = pr ? prState(i, p) : issueState(i, p);
    const ref = (name) => div().px(6).py(1).rounded(6).bg(`${p.link}22`).text_color(p.link).font_family(MONO).text_size(12).child(name);
    return h_flex().gap(8).items_center().flex_wrap().text_size(14).text_color(t.muted)
      .child(h_flex().h(32).px(12).gap(6).items_center().rounded(16).bg(color).text_color("#ffffff").font_semibold().child(glyph(icon, 16, "#ffffff")).child(state))
      .when(pr, (e) => e.child(div().font_semibold().text_color(t.foreground).child(loginOf(i.author)))
        .child(div().child(upper(i.state) === "MERGED" ? "merged into" : "wants to merge into")).child(ref(i.baseRefName)).child(div().child("from")).child(ref(i.headRefName))
        .child(div().pl(6).text_color(p.open).child(`+${i.additions}`)).child(div().text_color(p.closed).child(`−${i.deletions}`)).child(div().child(`· ${i.changedFiles} files`))
        .child(div().flex_1())
        .child(segmented("pr-subtab", [["conversation", "Conversation"], ["files", `Files changed (${i.changedFiles ?? 0})`]], this.subTab, t, (tab, cx) => this.setSubTab(tab, cx))))
      .when(!pr, (e) => e.child(div().child(`${loginOf(i.author)} opened ${ago(i.createdAt)} · ${(i.comments ?? []).length} comments`)));
  }

  render(cx) {
    const t = theme(), i = this.item, p = primer(t);
    const frame = v_flex().id("viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14);
    if (!i) return frame.px(32).pt(14).gap(20).child(this.toolbar(null, t))
      .child(this.loading ? div().text_color(t.muted).child(`Loading #${this.number}…`) : div().text_color(p.closed).child(this.error ?? ""));
    return frame
      .child(v_flex().flex_none().gap(14).px(32).pt(14).pb(18).border_b(1).border_color(t.border)
        .child(this.toolbar(i, t))
        .child(div().text_size(28).child(i.title))
        .child(this.byline(i, t, cx)))
      .when(this.pr() && this.subTab === "files", (e) => e.child(this.filesTab(i, t, cx)))
      .when(!(this.pr() && this.subTab === "files"), (e) => e.child(h_flex().flex_1().min_h(0).items_start()
        .child(v_flex().id(`thread-${this.key()}`).flex_1().min_w(0).h_full().overflow_y_scrollbar().pl(32).pr(24).py(20)
          .on_size_change((size, cx) => { if (size.width !== this.column) { this.column = size.width; cx.notify(); } })
          .children(this.conversation(i, t, cx))
          .child(div().flex_none().h(24))
          .when(this.pr() && this.open(), (x) => x.child(this.mergeBox(i, t, cx)).child(div().flex_none().h(20)))
          .child(this.composer(i, t, cx))
          .child(div().flex_none().h(24)))
        .child(this.aside(i, t, cx))));
  }
}
