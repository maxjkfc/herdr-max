import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { theme, closeOverlay, setShared, run, notify, nextCommand } from "herdr";
import { split, want, avatar } from "./media.js";
import { entries, tally, loginOf } from "./timeline.js";
import { primer, glyph, spinner, ago, openUrl, issueState, prState, checksOf, glyphOf, labelChip, button, badge } from "./ui.js";
import { ghJson, gh, localState } from "./gh.js";
import { issueBrief, prBrief } from "./brief.js";
import { copied, pickAgent, copyMenu, openIssueWorktree } from "./actions.js";

const FIELDS = {
  issue: "number,title,body,author,state,stateReason,labels,assignees,createdAt,updatedAt,comments,url,milestone,reactionGroups,closedByPullRequestsReferences",
  pr: "number,title,body,author,state,isDraft,labels,assignees,createdAt,updatedAt,comments,url,milestone,reactionGroups,headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,mergeable,reviewRequests,reviews,closingIssuesReferences,mergedAt",
};
const LINK = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/;
const ROLE = { OWNER: "Owner", MEMBER: "Member", COLLABORATOR: "Collaborator", CONTRIBUTOR: "Contributor" };
const VERDICT = {
  APPROVED: ["check-circle", "open", "已核准 (Approved)"],
  CHANGES_REQUESTED: ["x-circle", "closed", "要求修改 (Changes requested)"],
  COMMENTED: ["comment", null, "已審閱"],
  DISMISSED: ["skip", null, "審閱已撤銷"],
};
const METHODS = [["merge", "Merge commit", "pr-merged", "M"], ["squash", "Squash and merge", "commit", "S"], ["rebase", "Rebase and merge", "branch", "B"]];
const MONO = "JetBrains Mono";
const MAX_DIFF_ROWS = 5000;
const FILE_ROW_H = 26;
const FILE_VIEW_H = 148;

const display = (name) => name.replace(/^app\//, "").replace(/\[bot\]$/, "");
const isBot = (name) => /^app\/|\[bot\]$/.test(name);
const upper = (s) => String(s ?? "").toUpperCase();

function linkRefs(md, repo) {
  return md.split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, n) => n % 2 ? part
    : part.replace(/(^|[\s(])([\w.-]+\/[\w.-]+)?#(\d+)\b/g, (m, pre, other, num) => `${pre}[${other ?? ""}#${num}](https://github.com/${other ?? repo}/issues/${num})`)).join("");
}

export function parseDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
    const path = m ? m[2] : (lines[0] ?? "").trim();
    const file = { path, add: 0, del: 0, binary: false, rows: [] };
    let oldLine = 0, newLine = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { file.binary = true; continue; }
      if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity ") || line.startsWith("rename ")) continue;
      if (line.startsWith("@@")) {
        const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hm) { oldLine = Number(hm[1]); newLine = Number(hm[2]); }
        file.rows.push({ kind: "@", text: line });
      } else if (line.startsWith("+")) {
        file.add++; file.rows.push({ kind: "+", number: newLine++, text: line.slice(1) });
      } else if (line.startsWith("-")) {
        file.del++; file.rows.push({ kind: "-", number: oldLine++, text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        oldLine++; file.rows.push({ kind: " ", number: newLine++, text: line.slice(1) });
      }
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
    this.diffs = {}; this.fileIdx = 0; this.fileScroll = 0; this.diffRows = []; this.diffWidth = 0;
    this.merging = false; this.mergeError = null; this.typing = false;
    this.handle = cx.focus_handle();
    if (data) this.items[this.key()] = data;
    this.box = TextareaState.new({ placeholder: "輸入留言（支援 Markdown，按 c 聚焦、Esc 離開輸入框、Ctrl+Enter 送出）…" });
    this.box.set_auto_grow(3, 10);
    this.box.on("change", (_e, cx) => { const any = Boolean(this.box.value().trim()); if (any !== this.typed) { this.typed = any; cx.notify(); } });
    this.box.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.box.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.box.on("submit", (e, cx) => { if (e.secondary) this.comment(cx); });

    this.handle.focus();
    cx.timer.after(50, () => this.handle.focus());
    cx.timer.after(200, () => this.handle.focus());

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "down") this.stepFile(1);
        else if (cmd === "up") this.stepFile(-1);
        cx.notify();
      }
    });

    this.load(cx);
  }

  key() { return `${this.repo}#${this.number}`; }
  pr() { return this.kind === "pr"; }
  local() { return this.locals[this.repo] ?? null; }
  open() { return upper(this.item?.state) === "OPEN"; }

  load(cx) {
    const key = this.key(), kind = this.kind, still = () => this.key() === key;
    this.item = this.items[key] ?? null; this.error = null; this.loading = true;
    if (kind === "pr") this.loadDiff(cx, true);
    cx.spawn(async (cx) => {
      try {
        const [item, pages] = await Promise.all([
          ghJson([kind, "view", String(this.number), "-R", this.repo, "--json", FIELDS[kind]]),
          ghJson(["api", "--paginate", "--slurp", `repos/${this.repo}/issues/${this.number}/timeline?per_page=100`]).catch(() => null),
        ]);
        if (kind === "issue" && item.url.includes("/pull/")) { this.kind = "pr"; return this.load(cx); }
        Object.assign(item, { repo: this.repo }, kind === "pr" ? { checks: checksOf(item) } : {});
        this.items[key] = item;
        if (pages) this.threads[key] = entries(pages.flat());
        if (still()) this.item = item;
        if (this.local()?.folder) this.localState = await localState(this.local().folder);
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
  }

  ensureFileVisible(count) {
    const total = count * FILE_ROW_H;
    const height = Math.min(FILE_VIEW_H, total);
    if (this.fileIdx * FILE_ROW_H < this.fileScroll) this.fileScroll = this.fileIdx * FILE_ROW_H;
    if ((this.fileIdx + 1) * FILE_ROW_H > this.fileScroll + height) this.fileScroll = (this.fileIdx + 1) * FILE_ROW_H - height;
  }

  stepFile(delta) {
    const files = this.diffs[this.key()] ?? [];
    if (!files.length) return;
    const next = (this.fileIdx + delta + files.length) % files.length;
    this.pickDiffFile(next);
  }

  pickDiffFile(idx) {
    const files = this.diffs[this.key()] ?? [];
    this.fileIdx = files.length ? Math.max(0, Math.min(idx, files.length - 1)) : 0;
    this.ensureFileVisible(files.length);
    const rows = files[this.fileIdx]?.rows ?? [];
    this.diffRows = rows.length > MAX_DIFF_ROWS
      ? [...rows.slice(0, MAX_DIFF_ROWS), { kind: "@", text: `Diff truncated at ${MAX_DIFF_ROWS} lines` }]
      : rows;
    let longest = 0;
    for (const r of this.diffRows) if (r.text.length > longest) longest = r.text.length;
    this.diffWidth = Math.min(longest, 400) * 8 + 100;
  }

  canMerge() {
    const i = this.item;
    if (!i || !this.pr() || !this.open() || this.merging) return false;
    const c = i.checks ?? checksOf(i);
    if (i.isDraft || i.mergeable === "CONFLICTING" || c.state === "failure" || c.state === "pending") return false;
    return true;
  }

  mergePr(method, cx) {
    if (!this.canMerge()) return;
    const key = this.key(), repo = this.repo, number = this.number, title = this.item.title, sha = this.item.headRefOid;
    this.merging = true; this.mergeError = null;
    cx.spawn(async (cx) => {
      try {
        const args = ["pr", "merge", String(number), "-R", repo, `--${method}`];
        if (sha) args.push("--match-head-commit", sha);
        await gh(args);
        notify({ title: `PR #${number} 已合併`, body: title, level: "success", timeout: 3000 });
        setShared("github.changed", { repo, at: Date.now() });
        if (this.key() === key) { this.load(cx); }
      } catch (e) {
        if (this.key() === key) this.mergeError = String(e?.message ?? e);
      } finally {
        this.merging = false; cx.notify();
      }
    });
    cx.notify();
  }

  onKey(e, cx) {
    const k = e.key;
    if (this.typing) {
      if (k === "escape") {
        this.typing = false;
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
      }
      return;
    }
    if (k === "escape" || k === "q") {
      cx.stop_propagation();
      closeOverlay(this.overlay);
      return;
    }
    if (k === "j" || k === "down" || ((k === "n" || k === "j") && e.modifiers?.control)) {
      this.stepFile(1);
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (k === "k" || k === "up" || ((k === "p" || k === "k") && e.modifiers?.control)) {
      this.stepFile(-1);
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (!this.item) return;
    if (k === "m" && this.pr()) {
      this.mergePr("merge", cx);
      cx.stop_propagation();
    } else if (k === "s" && this.pr()) {
      this.mergePr("squash", cx);
      cx.stop_propagation();
    } else if (k === "b" && this.pr()) {
      this.mergePr("rebase", cx);
      cx.stop_propagation();
    } else if (k === "x" && this.pr() && this.open()) {
      this.checkout();
      cx.stop_propagation();
    } else if (k === "w" && !this.pr()) {
      this.openWorktree();
      cx.stop_propagation();
    } else if (k === "y") {
      copied(cx, this.brief(), "已複製 Agent Brief", `${this.repo}#${this.item.number}`);
      cx.stop_propagation();
    } else if (k === "a") {
      this.startAgent();
      cx.stop_propagation();
    } else if (k === "o") {
      openUrl(this.item.url);
      cx.stop_propagation();
    } else if (k === "r") {
      this.load(cx);
      cx.stop_propagation();
      cx.notify();
    } else if (k === "c") {
      this.typing = true;
      this.box.focus();
      cx.stop_propagation();
      cx.notify();
    }
  }

  goTo(repo, number, kind, cx) {
    if (repo === this.repo && number === this.number) return;
    this.trail.push({ repo: this.repo, number: this.number, kind: this.kind });
    Object.assign(this, { repo, number, kind, picking: false, mergeError: null, fileIdx: 0, fileScroll: 0 });
    this.load(cx); cx.notify();
  }
  goBack(cx) {
    const prev = this.trail.pop();
    if (!prev) return;
    Object.assign(this, { ...prev, picking: false, mergeError: null, fileIdx: 0, fileScroll: 0 });
    this.load(cx); cx.notify();
  }
  follow(url, cx) {
    const m = LINK.exec(url);
    if (m) return this.goTo(m[1], Number(m[3]), m[2] === "pull" ? "pr" : "issue", cx);
    openUrl(url);
  }

  act(label, cmd, args, cx, after) {
    const key = this.key(), repo = this.repo;
    this.busy = label; this.error = null;
    cx.spawn(async (cx) => {
      try {
        await gh([this.kind, cmd, String(this.number), "-R", repo, ...args]);
        setShared("github.changed", { repo, at: Date.now() });
        after?.();
      } catch (e) { if (this.key() === key) this.error = String(e?.message ?? e); }
      finally { this.busy = null; if (this.key() === key) this.load(cx); else cx.notify(); }
    });
    cx.notify();
  }
  comment(cx) {
    const body = this.box.value().trim();
    if (!body || this.busy) return;
    this.act("送出留言中…", "comment", ["-b", body], cx, () => { this.box.set_value(""); this.typed = false; this.mode = "write"; this.typing = false; this.handle.focus(); });
  }
  close(reason, cx) {
    const body = this.box.value().trim(), extra = [];
    if (!this.pr() && reason === "not_planned") extra.push("-r", "not planned");
    if (body) extra.push("-c", body);
    this.act("關閉中…", "close", extra, cx, () => { if (body) { this.box.set_value(""); this.typed = false; } });
  }
  reopen(cx) {
    const body = this.box.value().trim();
    this.act("重新開啟中…", "reopen", body ? ["-c", body] : [], cx, () => { if (body) { this.box.set_value(""); this.typed = false; } });
  }
  pickLabels(cx) {
    this.picking = !this.picking;
    if (this.picking && !this.repoLabels[this.repo]) {
      const repo = this.repo;
      cx.spawn(async (cx) => {
        this.repoLabels[repo] = await ghJson(["label", "list", "-R", repo, "--limit", "100", "--json", "name,color,description"]).catch(() => []);
        cx.notify();
      });
    }
    cx.notify();
  }
  flipLabel(label, cx) {
    const has = this.item.labels.some((l) => l.name === label.name);
    this.act("更新標籤中…", "edit", [has ? "--remove-label" : "--add-label", label.name], cx);
  }

  brief() {
    const local = this.local() ? { ...this.local(), ...this.localState } : null;
    return this.pr() ? prBrief(this.item, { local }) : issueBrief(this.item, { local });
  }
  startAgent() {
    const i = this.item, l = this.local();
    pickAgent({
      name: `${this.pr() ? "PR " : ""}#${i.number} ${this.repo.split("/")[1]}`,
      brief: this.brief(),
      folder: l?.folder ?? null,
      space: l?.space ?? null,
      issue: this.pr() ? null : { number: i.number, title: i.title },
    });
  }
  openWorktree() {
    const i = this.item, l = this.local();
    if (!i || this.pr()) return;
    openIssueWorktree({ issue: { number: i.number, title: i.title }, folder: l?.folder ?? null, space: l?.space ?? null })
      .then(() => closeOverlay(this.overlay))
      .catch((e) => notify({ title: "Worktree 建立失敗", body: String(e?.message ?? e), level: "error" }));
  }
  checkout() {
    const folder = this.local()?.folder;
    run("terminal.open", { argv: ["sh", "-c", `gh pr checkout ${this.number} && exec "\${SHELL:-sh}"`], ...(folder ? { folder } : {}), place: "tab" });
    closeOverlay(this.overlay);
  }

  waitFor(pending, cx) { if (pending) cx.spawn(async (cx) => { await pending; cx.notify(); }); }

  face(login, url, size, t, cx) {
    const { got, pending } = avatar(login, url);
    this.waitFor(pending, cx);
    if (got?.path) return image(got.path).size(size).flex_none().rounded(size / 2);
    const hues = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6], tint = hues[(login.length * 7 + login.charCodeAt(0)) % hues.length];
    return div().size(size).flex_none().rounded(size / 2).bg(`${tint}33`).text_color(tint).font_semibold().text_size(Math.round(size / 2))
      .flex().items_center().justify_center().child(display(login).charAt(0).toUpperCase());
  }

  prose(key, body, t, cx) {
    return v_flex().gap(10).children(split(body).map((part, n) => part.image ? this.shot(`${key}-${n}`, part, t, cx)
      : TextView.markdown(`${key}-${n}`, linkRefs(part.text, this.repo)).selectable(true).on_link_click((url, cx) => this.follow(url, cx))));
  }

  shot(key, part, t, cx) {
    const { got, pending } = want(part.image);
    this.waitFor(pending, cx);
    if (!got?.path) {
      const lost = got === "missing";
      return h_flex().id(key).h(lost ? 36 : 100).w_full().flex_none().px(12).gap(8).items_center().justify_center().rounded(6).border_1().border_color(t.border).bg(t.raised)
        .text_size(12).text_color(t.muted).cursor_pointer().on_click(() => openUrl(part.image))
        .child(lost ? glyph("image", 14, t.muted) : spinner(14, t.muted))
        .child(div().min_w(0).truncate().child(lost ? `圖片無法載入 · 點擊開啟` : "載入圖片中…"));
    }
    const fit = Math.max(200, (this.column ?? 520) - 34), w = Math.min(part.width ?? got.width, got.width, fit);
    return div().id(key).flex_none().cursor_pointer().on_click(() => openUrl(got.file)).child(image(got.path).w(w).h(Math.round(got.height * w / got.width)).rounded(6));
  }

  card(key, c, t, cx) {
    const p = primer(t), verdict = c.review ? VERDICT[c.review] : null, author = loginOf(this.item.author);
    const head = h_flex().h(34).px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(12.5)
      .child(this.face(c.who, c.avatar, 18, t, cx))
      .child(div().font_semibold().child(display(c.who)))
      .when(isBot(c.who), (e) => e.child(badge("bot", t)))
      .when(Boolean(verdict), (e) => e.child(glyph(verdict[0], 13, verdict[1] ? p[verdict[1]] : t.muted)).child(div().text_color(t.muted).child(verdict[2])))
      .child(div().text_color(t.muted).child(ago(c.at)))
      .child(div().flex_1())
      .when(!c.opening && c.who === author, (e) => e.child(badge("作者", t)))
      .when(!c.opening && Boolean(ROLE[c.role]), (e) => e.child(badge(ROLE[c.role], t)));
    const text = c.body?.trim();
    return v_flex().flex_none().rounded(7).overflow_hidden().bg(t.background).border_1().border_color(c.review === "CHANGES_REQUESTED" ? `${p.closed}88` : t.border)
      .child(head)
      .when(Boolean(text) || c.opening, (e) => e.child(div().px(14).py(12).text_size(13.5)
        .child(text ? this.prose(key, text, t, cx) : div().italic().text_color(t.muted).child("（無說明內容）"))))
      .when(c.reactions?.length > 0, (e) => e.child(h_flex().px(14).pb(10).gap(6).flex_wrap()
        .children(c.reactions.map((r) => div().h(22).px(7).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(11.5).text_color(t.muted).child(r)))));
  }

  line(e, t) {
    const p = primer(t), pr = this.pr();
    if (e.labels) {
      const { added, removed } = e.labels;
      return ["tag", null, [...(added.length ? ["加上", ...added.map((label) => ({ label }))] : []), ...(added.length && removed.length ? ["並"] : []),
        ...(removed.length ? ["移除", ...removed.map((label) => ({ label }))] : []), "標籤"]];
    }
    if (e.assigned) return ["user", null, e.assigned === e.who ? ["自行接手"] : ["指派給", { b: display(e.assigned) }]];
    if (e.unassigned) return ["user", null, ["取消指派", { b: display(e.unassigned) }]];
    if (e.closed) return e.closed === "not_planned" ? ["issue-skip", p.neutral, ["以不處理關閉"]]
      : [pr ? "pr-closed" : "issue-done", pr ? p.closed : p.done, [pr ? "關閉此 PR" : "完成並關閉"]];
    if (e.reopened) return [pr ? "pr-open" : "issue-open", p.open, ["重新開啟"]];
    if (e.merged) return ["pr-merged", p.done, ["合併了 commit", { code: e.merged.sha }]];
    if (e.renamed) return ["pencil", null, ["修改標題", { struck: e.renamed.from }, { b: e.renamed.to }]];
    if (e.milestone) return ["milestone", null, [e.milestone.added ? "加入里程碑" : "移出里程碑", { b: e.milestone.title }]];
    if (e.mention) return ["link", null, ["提及此項目"]];
    if (e.commit) return ["commit", null, [e.commit.message ? "提交" : "新增相關 commit"]];
    return ["dot", null, []];
  }

  event(key, e, t, cx) {
    const p = primer(t), [icon, fill, words] = this.line(e, t);
    const word = (w) => typeof w === "string" ? div().child(w) : w.b !== undefined ? div().font_semibold().text_color(t.foreground).child(w.b)
      : w.label ? labelChip(w.label, t, true) : w.code ? div().font_family(MONO).text_size(11.5).child(w.code) : div().line_through().child(w.struck ?? "");
    const target = e.mention ?? (e.commit?.url ? e.commit : null);
    const badgeIcon = h_flex().size(24).flex_none().justify_center().items_center().rounded(6).border_1()
      .bg(fill ? `${fill}28` : t.raised).border_color(fill ? `${fill}88` : t.border).child(glyph(icon, 13, fill ?? t.muted));
    return v_flex().flex_none().gap(4)
      .child(h_flex().pl(4).gap(8).items_center().child(badgeIcon)
        .child(h_flex().flex_1().min_w(0).gap(5).flex_wrap().items_center().text_size(12.5).text_color(t.muted)
          .when(!e.commit, (x) => x.child(this.face(e.who, e.avatar, 15, t, cx)))
          .child(div().font_semibold().text_color(t.foreground).child(display(e.who)))
          .children(words.map(word))
          .child(div().child(ago(e.at)))))
      .when(Boolean(target), (x) => x.child(h_flex().id(key).ml(36).gap(6).items_center().cursor_pointer().text_size(12)
        .on_click((_ev, cx) => this.follow(target.url, cx))
        .when(Boolean(e.mention), (y) => y.child(glyph(e.mention.pr ? (e.mention.merged ? "pr-merged" : "pr-open") : "issue-open", 14, e.mention.open ? p.open : e.mention.merged || !e.mention.open ? p.done : t.muted))
          .child(div().font_semibold().text_color(t.foreground).hover((s) => s.text_color(p.link)).child(e.mention.title ?? ""))
          .child(div().text_color(t.muted).child(`#${e.mention.number}`)))
        .when(Boolean(e.commit), (y) => y.when(Boolean(e.commit.message), (z) => z.child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(e.commit.message)))
          .child(div().px(5).py(1).rounded(4).bg(t.raised).border_1().border_color(t.border).font_family(MONO).text_color(t.muted).hover((s) => s.text_color(p.link)).child(e.commit.sha)))));
  }

  conversation(i, t, cx) {
    const thread = this.threads[this.key()]
      ?? (i.comments ?? []).map((c) => ({ card: "comment", who: loginOf(c.author), at: c.createdAt, body: c.body, role: c.authorAssociation, reactions: tally(c.reactionGroups) }));
    const opening = { card: "comment", opening: true, who: loginOf(i.author), at: i.createdAt, body: i.body, reactions: tally(i.reactionGroups) };
    const rail = () => div().flex_none().ml(15).w(2).h(12).bg(t.border);
    return [this.card("opening", opening, t, cx), ...thread.flatMap((e, n) => [rail(), e.card ? this.card(`c${n}`, e, t, cx) : this.event(`e${n}`, e, t, cx)])];
  }

  mergeConsole(i, t, cx) {
    const p = primer(t), c = i.checks ?? checksOf(i);
    const conflict = i.mergeable === "CONFLICTING";
    const blocked = i.isDraft
      ? "草稿 PR（Draft）"
      : conflict
      ? "與目標分支有衝突（Conflicts）"
      : c.state === "failure"
      ? "CI 檢查未通過"
      : c.state === "pending"
      ? "CI 檢查執行中"
      : null;
    const checkSummary = !c.runs?.length
      ? "無 CI 檢查"
      : `${c.runs.length - c.failed.length - c.pending.length} 通過${c.failed.length ? ` · ${c.failed.length} 失敗` : ""}${c.pending.length ? ` · ${c.pending.length} 執行中` : ""}`;
    const checkColor = c.state === "failure" ? p.closed : c.state === "pending" ? p.attention : p.open;

    return v_flex().flex_none().p(12).gap(10).rounded(8).bg(t.raised).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center().text_size(12.5)
        .child(glyphOf(c.state === "failure" ? "x-circle" : c.state === "pending" ? "spin" : "check-circle", 15, checkColor, t))
        .child(div().font_semibold().text_color(t.foreground).child(blocked ? `無法合併：${blocked}` : "可安全合併（無衝突）"))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.muted).child(checkSummary)))
      .child(h_flex().gap(8).flex_wrap().children(METHODS.map(([m, label, ic, keyHint]) =>
        button(`pr-merge-${m}`, `${label} [${keyHint}]`, t, (_e, cx) => this.mergePr(m, cx), {
          primary: m === "merge",
          color: m === "merge" ? p.open : m === "squash" ? p.done : p.link,
          icon: ic,
          small: true,
          enabled: !blocked && !this.merging,
          tooltip: `按 ${keyHint} 直接執行 ${label}`,
        }))))
      .when(this.merging, (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.working)).child("正在執行 gh pr merge…")))
      .when(Boolean(this.mergeError), (e) => e.child(div().text_size(12).text_color(p.closed).child(this.mergeError)));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(22).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(22).flex_none().gap(10)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18"))
      .when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // Right-hand side of the PR split workbench: scrollable + keyboard-navigable changed files strip + live unified diff.
  diffWorkbench(i, t, cx) {
    const p = primer(t), files = this.diffs[this.key()] ?? [];
    const total = files.length * FILE_ROW_H;
    const height = Math.min(FILE_VIEW_H, Math.max(FILE_ROW_H, total));
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.fileScroll = Math.max(0, Math.min(this.fileScroll, maxScroll));
    this.ensureFileVisible(files.length);

    const placeRow = (el, idx) => fixed
      ? el.absolute().left(6).right(fixed ? 14 : 6).top(idx * FILE_ROW_H - this.fileScroll).h(FILE_ROW_H)
      : el;
    const visible = (idx) => !fixed || ((idx + 1) * FILE_ROW_H > this.fileScroll && idx * FILE_ROW_H < this.fileScroll + height);

    const renderFileRow = (f, idx) => {
      const on = this.fileIdx === idx;
      return h_flex().id(`pr-df-${idx}`).h(FILE_ROW_H).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .bg(on ? t.selected : "#00000000")
        .border_1().border_color(on ? t.accent : "#00000000")
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pickDiffFile(idx); cx.notify(); })
        .child(div().w(34).flex_none().text_size(11).text_color(on ? t.accent : t.dim).font_family(MONO).child(`${idx + 1}/${files.length}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_family(MONO).text_color(on ? t.foreground : t.muted).when(on, (x) => x.font_semibold()).child(f.path))
        .when(f.binary, (e) => e.child(div().text_size(11).text_color(t.dim).child("binary")))
        .when(f.add > 0, (e) => e.child(div().text_size(11.5).text_color(p.open).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().text_size(11.5).text_color(p.closed).child(`−${f.del}`)));
    };

    const thumbH = fixed ? Math.max(20, Math.round((height / total) * height)) : 0;
    const thumbTop = fixed && maxScroll > 0 ? Math.round((this.fileScroll / maxScroll) * (height - thumbH)) : 0;

    return v_flex().flex_1().min_w(0).h_full().bg(t.background)
      .child(v_flex().id("pr-diff-files-panel").flex_none().border_b(1).border_color(t.border).bg(t.surface)
        .child(h_flex().px(14).py(6).gap(8).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
          .child(div().font_semibold().text_color(t.foreground).child(`異動檔案 (${files.length ? `${this.fileIdx + 1} / ${files.length}` : i.changedFiles || 0})`))
          .child(div().px(6).py(1).rounded(4).bg(t.background).border_1().border_color(t.border).text_size(11).text_color(t.dim).child("j / k 或 ↑ / ↓ 切換檔案"))
          .child(div().flex_1())
          .when(files.length > 1, (e) => e
            .child(button("df-prev", "↑ 上一個", t, (_e, cx) => { this.stepFile(-1); cx.notify(); }, { small: true, invisible: true }))
            .child(button("df-next", "↓ 下一個", t, (_e, cx) => { this.stepFile(1); cx.notify(); }, { small: true, invisible: true })))
          .child(div().text_color(p.open).child(`+${i.additions ?? 0}`))
          .child(div().pl(4).text_color(p.closed).child(`−${i.deletions ?? 0}`)))
        .when(this.diffLoading && !files.length, (e) => e.child(h_flex().px(14).py(10).gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.working)).child("正在載入 Diff…")))
        .when(Boolean(this.diffError), (e) => e.child(div().px(14).py(8).text_size(12).text_color(p.closed).child(this.diffError)))
        .when(files.length > 0, (e) => e.child(
          v_flex().id("pr-diff-files-viewport").relative().h(height + (fixed ? 0 : 8)).min_h(0).px(6).py(fixed ? 0 : 4)
            .when(fixed, (el) => el.overflow_hidden().on_scroll_wheel((ev, cx) => {
              this.fileScroll = Math.max(0, Math.min(this.fileScroll - ev.delta.y, maxScroll));
              cx.notify();
            }))
            .children(files.map((f, idx) => visible(idx) ? placeRow(renderFileRow(f, idx), idx) : null).filter(Boolean))
            .when(fixed, (el) => el.child(div().absolute().right(4).top(thumbTop).w(4).h(thumbH).rounded(2).bg(t.border)))
        )))
      .child(div().flex_1().min_h(0).relative().font_family(MONO).text_size(12.5)
        .child(div().id("pr-diff-scroll-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(
            v_virtual_list("pr-diff-rows", this.diffRows.length, 22, (idx) => String(idx),
              (range) => this.diffRows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("pr-diff-rows").viewport_from_layout().absolute().inset_0()));
  }

  composer(i, t, cx) {
    const p = primer(t), busy = Boolean(this.busy), pr = this.pr(), open = this.open();
    const actions = upper(i.state) === "MERGED" ? [] : open
      ? [button("close", this.typed ? "留言並關閉" : `關閉 ${pr ? "PR" : "Issue"}`, t, (_e, cx) => this.close("completed", cx), { enabled: !busy, small: true, icon: pr ? "pr-closed" : "issue-done", color: p.closed })]
      : [button("reopen", "重新開啟", t, (_e, cx) => this.reopen(cx), { enabled: !busy, small: true, icon: pr ? "pr-open" : "issue-open", color: p.open })];
    return v_flex().flex_none().gap(8)
      .child(v_flex().rounded(7).border_1().border_color(this.typing ? t.accent : t.border).overflow_hidden().bg(t.background)
        .child(div().id("box").px(10).py(8).cursor_text()
          .on_mouse_down("left", (_e, cx) => { this.typing = true; cx.notify(); })
          .child(Textarea.new(this.box).w_full().text_size(13.5).text_color(t.foreground)))
        .child(h_flex().px(10).py(8).gap(6).items_center().border_t(1).border_color(t.border).bg(t.surface)
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child("按 c 留言 · Esc 離開輸入 · Ctrl+Enter 送出"))
          .children(actions)
          .child(button("comment", "送出留言", t, (_e, cx) => this.comment(cx), { primary: true, small: true, enabled: this.typed && !busy }))));
  }

  aside(i, t, cx) {
    const p = primer(t), me = this.me, local = this.local(), ls = this.localState;
    const quiet = (text) => div().text_size(12.5).text_color(t.muted).child(text);
    const link = (id, label, onClick) => div().id(id).text_size(12.5).text_color(p.link).cursor_pointer().hover((s) => s.underline()).on_click(onClick).child(label);
    const part = (title, body, extra = null) => v_flex().flex_none().gap(8).py(12).border_b(1).border_color(t.border)
      .child(h_flex().items_center().text_size(12).font_semibold().text_color(t.muted).child(div().flex_1().child(title)).when(Boolean(extra), (e) => e.child(extra)))
      .child(body);
    const person = (login) => h_flex().gap(8).items_center().text_size(13).child(this.face(login, null, 20, t, cx)).child(div().flex_1().min_w(0).truncate().font_semibold().child(display(login)));
    const mine = i.assignees.some((a) => a.login === me), labels = this.repoLabels[this.repo];

    return v_flex().id("aside").w(250).flex_none().min_h(0).overflow_y_scrollbar().px(16).py(12).border_l(1).border_color(t.border)
      .child(part("快速動作", v_flex().gap(6)
        .child(button("aside-wt", "🌱 建立 / 切換 Worktree [W]", t, () => this.openWorktree(), { primary: true, color: p.link }))
        .child(button("aside-agent", "⚡ 派發 Agent 處理 [A]", t, () => this.startAgent(), { color: p.open }))))
      .child(part("指派 (Assignees)",
        i.assignees.length ? v_flex().gap(8).children(i.assignees.map((a) => person(a.login)))
          : h_flex().gap(4).child(quiet("未指派")).when(Boolean(me), (e) => e.child(quiet("·")).child(link("assign", "指派給自己", (_e, cx) => this.act("指派中…", "edit", ["--add-assignee", "@me"], cx)))),
        mine ? link("unassign", "取消指派", (_e, cx) => this.act("取消指派中…", "edit", ["--remove-assignee", "@me"], cx)) : null))
      .child(part("標籤 (Labels)",
        this.picking ? (!labels ? quiet("載入中…") : !labels.length ? quiet("無標籤") : h_flex().gap(4).flex_wrap().children(labels.map((l) => {
          const on = i.labels.some((x) => x.name === l.name);
          return div().id(`label-${l.name}`).cursor_pointer().when(!on, (e) => e.opacity(0.45)).hover((s) => s.opacity(1))
            .on_click((_e, cx) => this.flipLabel(l, cx)).child(labelChip(l, t));
        })))
          : i.labels.length ? h_flex().gap(4).flex_wrap().children(i.labels.map((l) => labelChip(l, t))) : quiet("無標籤"),
        link("labels", this.picking ? "完成" : "編輯", (_e, cx) => this.pickLabels(cx))))
      .child(part("本機狀態", local ? v_flex().gap(4).text_size(12)
        .child(h_flex().gap(6).items_center().child(glyph("folder", 12, t.muted)).child(div().truncate().child(local.folder)))
        .when(Boolean(ls), (e) => e.child(h_flex().gap(6).items_center().text_color(t.muted).child(glyph("branch", 12, t.muted))
          .child(div().truncate().child([ls.branch, ls.changed && `${ls.changed} 異動`, ls.ahead && `↑${ls.ahead}`, ls.behind && `↓${ls.behind}`].filter(Boolean).join(" · ")))))
        : quiet("本機尚未 clone")));
  }

  headerBar(i, t) {
    const p = primer(t), pr = this.pr();
    const [icon, color, state] = i ? (pr ? prState(i, p) : issueState(i, p)) : ["dot", t.muted, "…"];
    const ref = (name) => div().px(6).py(1).rounded(4).border_1().border_color(`${p.link}55`).bg(`${p.link}18`).text_color(p.link).font_family(MONO).text_size(12).child(name);

    return v_flex().flex_none().gap(8).px(20).py(12).border_b(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .when(this.trail.length > 0, (e) => e.child(button("back", "返回", t, (_e, cx) => this.goBack(cx), { icon: "back", small: true })))
        .child(h_flex().h(24).px(8).gap(5).items_center().rounded(5).border_1().border_color(`${color}88`).bg(`${color}20`).text_color(color).text_size(12).font_semibold()
          .child(glyph(icon, 13, color)).child(state))
        .child(div().text_size(13).font_semibold().text_color(t.muted).child(`${this.repo} #${this.number}`))
        .when(pr && Boolean(i), (e) => e.child(ref(i.headRefName)).child(div().text_size(12).text_color(t.dim).child("→")).child(ref(i.baseRefName)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(p.closed).child(i && this.error ? this.error : ""))
        .when(this.loading || Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.working)).child(this.busy ?? "更新中…")))
        .when(Boolean(i) && !this.loading && !this.busy, (e) => e.child(button("refresh", "R", t, (_e, cx) => { this.load(cx); cx.notify(); }, { icon: "refresh", small: true, invisible: true, tooltip: "重新整理 [R]" })))
        .when(Boolean(i), (e) => e
          .child(button("github", "O", t, () => openUrl(i.url), { icon: "external", small: true, invisible: true, tooltip: "在 GitHub 開啟 [O]" }))
          .when(!pr, (x) => x.child(button("open-wt", "🌱 Worktree [W]", t, () => this.openWorktree(), { color: p.link, small: true, tooltip: "建立或切換至此 Issue 的 Worktree [W]" })))
          .when(pr && this.open(), (x) => x.child(button("checkout", "Checkout [X]", t, () => this.checkout(), { icon: "terminal", small: true, tooltip: "在新 Tab 執行 gh pr checkout [X]" })))
          .child(button("brief", "複製 Brief [Y]", t, (_e, cx) => copied(cx, this.brief(), "已複製 Agent Brief", `${this.repo}#${i.number}`), { icon: "brief", small: true }))
          .child(button("agent", "⚡ 派 Agent [A]", t, () => this.startAgent(), { primary: true, small: true })))
        .child(button("close-dialog", "Esc", t, () => closeOverlay(this.overlay), { icon: "close", small: true, invisible: true, tooltip: "關閉視窗 [Esc / Q]" })))
      .when(Boolean(i), (e) => e.child(h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(17).font_semibold().text_color(t.foreground).child(i.title))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(
          pr
            ? "快捷鍵：j/k 換檔 · m/s/b 合併 · x Checkout · y 複製 · a 派 Agent · c 留言 · q/Esc 關閉"
            : "快捷鍵：w 開 Worktree · a 派 Agent · y 複製 · c 留言 · o 開網頁 · q/Esc 關閉"
        ))));
  }

  render(cx) {
    const t = theme(), i = this.item, p = primer(t), pr = this.pr();
    const frame = v_flex().id("viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13.5)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx));
    if (!i) return frame.child(this.headerBar(null, t))
      .child(div().p(24).text_color(this.loading ? t.muted : p.closed).child(this.loading ? `載入 #${this.number} 中…` : (this.error ?? "")));

    if (pr) {
      return frame
        .child(this.headerBar(i, t))
        .child(h_flex().flex_1().min_h(0)
          .child(v_flex().id(`pr-left-${this.key()}`).w(430).flex_none().h_full().overflow_y_scrollbar().p(16).gap(12).border_r(1).border_color(t.border)
            .on_size_change((size, cx) => { if (size.width !== this.column) { this.column = size.width; cx.notify(); } })
            .when(this.open(), (x) => x.child(this.mergeConsole(i, t, cx)))
            .children(this.conversation(i, t, cx))
            .child(div().flex_none().h(8))
            .child(this.composer(i, t, cx)))
          .child(this.diffWorkbench(i, t, cx)));
    }

    return frame
      .child(this.headerBar(i, t))
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().id(`issue-left-${this.key()}`).flex_1().min_w(0).h_full().overflow_y_scrollbar().p(20).gap(12)
          .on_size_change((size, cx) => { if (size.width !== this.column) { this.column = size.width; cx.notify(); } })
          .children(this.conversation(i, t, cx))
          .child(div().flex_none().h(12))
          .child(this.composer(i, t, cx)))
        .child(this.aside(i, t, cx)));
  }
}
