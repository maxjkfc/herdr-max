import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, closeOverlay, setShared } from "herdr";
import { primer, glyph, spinner, ago, duration, openUrl, runState, glyphOf, button } from "./ui.js";
import { ghJson, gh, failedLog, localState } from "./gh.js";
import { runBrief } from "./brief.js";
import { pickAgent } from "./actions.js";

// One workflow run: its jobs and steps, the failing log, and what to do about it.
export class RunView {
  constructor({ run, local }, overlay, cx) {
    Object.assign(this, { run, local, overlay, jobs: null, log: null, open: {} });
    this.load(cx);
  }

  load(cx) {
    this.loading = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const r = await ghJson(["run", "view", String(this.run.databaseId), "-R", this.run.repo, "--json", "jobs,status,conclusion,attempt,updatedAt,startedAt,headSha"]);
        Object.assign(this.run, { status: r.status, conclusion: r.conclusion, attempt: r.attempt, updatedAt: r.updatedAt, headSha: r.headSha ?? this.run.headSha });
        this.jobs = r.jobs ?? [];
        for (const j of this.jobs) if (/failure|timed_out/.test(j.conclusion) && this.open[j.name] === undefined) this.open[j.name] = true;
        cx.notify();
        if (this.jobs.some((j) => /failure|timed_out/.test(j.conclusion)) && this.log === null) this.log = await failedLog(this.run.repo, this.run.databaseId);
        if (this.local?.folder) this.localState = await localState(this.local.folder);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  rerun(cx, failedOnly) {
    if (this.busy) return;
    this.busy = failedOnly ? "Re-running failed jobs" : "Re-running all jobs";
    cx.spawn(async (cx) => {
      try { await gh(["run", "rerun", String(this.run.databaseId), "-R", this.run.repo, ...(failedOnly ? ["--failed"] : [])]); setShared("github.changed", { repo: this.run.repo, at: Date.now() }); }
      catch (e) { this.error = String(e?.message ?? e); }
      finally { this.busy = null; this.load(cx); }
    });
    cx.notify();
  }

  brief() { return runBrief(this.run, { jobs: this.jobs ?? [], log: this.log ?? "", local: this.local ? { ...this.local, ...this.localState } : null }); }

  job(j, t, cx) {
    const p = primer(t), [g, color] = runState(j, p), open = Boolean(this.open[j.name]);
    return v_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().id(`job-${j.databaseId ?? j.name}`).h(40).px(12).gap(10).items_center().bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.open[j.name] = !open; cx.notify(); })
        .child(glyph(open ? "chevron-down" : "chevron-right", 14, t.muted))
        .child(glyphOf(g, 16, color, t))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(j.name))
        .when(Boolean(j.startedAt && j.completedAt), (e) => e.child(div().text_size(12).text_color(t.muted).child(duration(j.startedAt, j.completedAt))))
        .child(button(`job-open-${j.databaseId}`, "", t, () => openUrl(j.url), { icon: "external", invisible: true, small: true, tooltip: "Open job on GitHub" })))
      .when(open, (e) => e.child(v_flex().py(4).bg(t.background).children((j.steps ?? []).map((s, n) => {
        const [sg, sc] = runState(s, p), bad = /failure/.test(s.conclusion ?? "");
        return h_flex().h(28).px(14).gap(10).items_center().text_size(12.5).when(bad, (x) => x.bg(`${p.closed}14`))
          .child(div().w(18).text_color(t.dim).text_right().child(String(s.number ?? n + 1)))
          .child(glyphOf(sg, 14, sc, t))
          .child(div().flex_1().min_w(0).truncate().text_color(bad ? t.foreground : t.muted).child(s.name))
          .when(Boolean(s.startedAt && s.completedAt), (x) => x.child(div().text_color(t.dim).child(duration(s.startedAt, s.completedAt))));
      }))));
  }

  render(cx) {
    const t = theme(), p = primer(t), r = this.run, [g, color, label] = runState(r, p);
    const failing = (this.jobs ?? []).some((j) => /failure|timed_out|cancelled/.test(j.conclusion ?? ""));
    return v_flex().id("run").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14)
      .child(v_flex().flex_none().px(32).pt(14).pb(18).gap(12).border_b(1).border_color(t.border)
        .child(h_flex().h(32).gap(8).items_center()
          .child(glyph("actions", 14, t.muted)).child(div().text_size(13).text_color(t.muted).child(`${r.repo} · ${r.workflowName}`))
          .child(div().flex_1().min_w(0).text_size(12).text_color(p.closed).truncate().child(this.error ?? ""))
          .when(this.loading || Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(spinner(12, t.working)).child(this.busy ?? "Loading")))
          .when(!this.loading && !this.busy, (e) => e.child(button("refresh", "", t, (_e, cx) => this.load(cx), { icon: "refresh", tooltip: "Refresh" })))
          .child(button("github", "", t, () => openUrl(r.url), { icon: "external", tooltip: "Open on GitHub" }))
          .when(failing, (e) => e.child(button("rerun", "Re-run failed jobs", t, (_e, cx) => this.rerun(cx, true), { icon: "refresh", enabled: !this.busy })))
          .when(r.status === "completed" && !failing, (e) => e.child(button("rerun-all", "Re-run", t, (_e, cx) => this.rerun(cx, false), { icon: "refresh", enabled: !this.busy })))
          .when(failing, (e) => e.child(button("agent", "派 Agent 修復", t, () => pickAgent({ name: `CI ${r.workflowName} ${r.repo.split("/")[1]}`, brief: this.brief(), folder: this.local?.folder ?? null, space: this.local?.space ?? null }), { primary: true, icon: "agent" })))
          .child(button("close", "", t, () => closeOverlay(this.overlay), { icon: "close", invisible: true, tooltip: "Close (Esc)" })))
        .child(h_flex().gap(10).items_center().child(glyphOf(g, 22, color, t)).child(div().flex_1().min_w(0).text_size(24).truncate().child(r.displayTitle)))
        .child(h_flex().gap(14).flex_wrap().text_size(13).text_color(t.muted)
          .child(div().text_color(color).font_semibold().child(label))
          .child(div().child(`#${r.number} · attempt ${r.attempt ?? 1}`))
          .child(h_flex().gap(5).items_center().child(glyph("branch", 13, t.muted)).child(div().font_family("JetBrains Mono").text_size(12).child(r.headBranch)))
          .child(h_flex().gap(5).items_center().child(glyph("commit", 13, t.muted)).child(div().font_family("JetBrains Mono").text_size(12).child(String(r.headSha ?? "").slice(0, 7))))
          .child(div().child(`${r.event} · ${ago(r.createdAt)}`))
          .when(Boolean(r.startedAt && r.updatedAt) && r.status === "completed", (e) => e.child(div().child(`took ${duration(r.startedAt ?? r.createdAt, r.updatedAt)}`)))))
      .child(v_flex().id("run-body").flex_1().min_h(0).overflow_y_scrollbar().px(32).py(20).gap(10)
        .when(!this.jobs, (e) => e.child(div().text_color(t.muted).child("Loading jobs…")))
        .children((this.jobs ?? []).map((j) => this.job(j, t, cx)))
        .when(Boolean(this.log), (e) => e.child(div().pt(14).text_size(14).font_semibold().child("Failure log")).child(div().text_size(12).text_color(t.muted).child("The lines around the errors; the brief carries the same excerpt."))
          .child(div().id("log").flex_none().max_h(420).overflow_y_scrollbar().p(12).rounded(6).bg(t.raised).border_1().border_color(t.border)
            .font_family("JetBrains Mono").text_size(11.5).text_color(t.foreground).child(this.log)))
        .when(this.log === "" && failing, (e) => e.child(div().text_size(12).text_color(t.muted).child("The log could not be read; the brief points the agent to gh run view --log-failed."))));
  }
}
