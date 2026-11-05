import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { agents, panes, spaces, knownAgents, hc, run, notify, closeOverlay, setShared, theme } from "herdr";
import { matchAgents } from "./drafts.js";

// The send dialog: the review (or a question about some lines) goes to one agent. The review dialog opens it with
// { title, text, ask, root, on, count } and learns it was sent from shared("review.sent").
export class SendDialog {
  constructor({ title, text, ask, root, on, count }, overlay, cx) {
    Object.assign(this, { title, text, ask: Boolean(ask), root, on: on ?? null, count: count ?? 0, overlay });
    this.pick = null; this.confirm = false; this.sending = false; this.error = null; this.known = null; this.note = "";
    this.handle = cx.focus_handle();
    this.noteInput = TextareaState.new({ placeholder: this.ask ? "你想問 agent 什麼？" : "補充說明（選填）…" });
    this.noteInput.set_auto_grow(2, 6);
    this.noteInput.on("change", (_e, cx) => { this.note = this.noteInput.value(); this.confirm = false; this.error = null; cx.notify(); });
    this.noteInput.on("submit", (e, cx) => { if (e.secondary) this.send(cx); });
    cx.timer.after(40, () => this.noteInput.focus());
    // The agents that can be started, for when none is running.
    cx.spawn(async (cx) => {
      try { this.known = (await knownAgents({ on: this.on })).filter((a) => a.installed && a.run).slice(0, 4); } catch { this.known = []; }
      cx.notify();
    });
  }

  candidates() { return matchAgents({ agents: agents(), panes: panes(), spaces: spaces(), root: this.root, on: this.on }); }
  chosen() { const list = this.candidates(); return (list.find((x) => x.agent.address === this.pick) ?? list[0])?.agent ?? null; }
  message() { return this.note.trim() ? `${this.note.trim()}\n\n${this.text}` : this.text; }
  ready() { return !this.sending && (!this.ask || Boolean(this.note.trim())); }

  sent(label, cx) {
    setShared("review.sent", { at: Date.now(), ask: this.ask });
    notify({ title: this.ask ? "已送出問題" : `已送出審查（${this.count} 則留言）`, body: label, level: "success", timeout: 4000 });
    closeOverlay(this.overlay);
  }

  send(cx) {
    const agent = this.chosen();
    if (!agent || !this.ready()) return;
    const busy = agent.status === "working" || agent.status === "blocked";
    // Text sent to a busy agent is typed into its input now: ask once.
    if (busy && !this.confirm) { this.confirm = true; cx.notify(); return; }
    this.sending = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["send", ...(agent.status === "blocked" ? ["--force"] : []), agent.address, this.message()]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      if (r.code === 0) {
        if (!this.ask) run("pane.focus", { terminal: agent.address });
        this.sent(agent.program?.name ?? agent.app ?? agent.address, cx);
      } else { this.error = (r.stderr || r.stdout).trim().slice(0, 300) || "hc send 失敗"; this.sending = false; this.confirm = false; }
      cx.notify();
    });
  }

  // No agent is running: start one in a new tab with the message as its first task.
  start(prog, cx) {
    if (!this.ready()) return;
    // No `space`: the tab opens in the space being looked at (where review was opened from), with `folder` as its cwd.
    // Naming a space by folder match failed with "no space <id>" when the match was one tab.new can't resolve.
    this.sending = true; cx.notify();
    run("tab.new", { name: "審查", folder: this.root, argv: prog.run, task: this.message() });
    this.sent(prog.name, cx);
  }

  onKey(e, cx) {
    if (e.key === "escape") { closeOverlay(this.overlay); cx.stop_propagation(); }
    else if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) { this.send(cx); cx.stop_propagation(); }
  }

  render(cx) {
    const t = theme(), list = this.candidates(), agent = this.chosen();
    const busy = agent && (agent.status === "working" || agent.status === "blocked");
    const color = { working: t.working, blocked: t.blocked, done: t.done, idle: t.dim };
    const button = (id, label, on, on_click, primary = false) => div().id(id).h(28).px(12).flex().items_center().flex_none().rounded(6).border_1()
      .border_color(primary && on ? t.accent : t.border).bg(primary && on ? t.accent : "#00000000").text_size(12.5).font_semibold()
      .text_color(primary && on ? t.accent_foreground : on ? t.foreground : t.dim).when(on, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_click(on ? on_click : () => {}).child(label);
    const row = (a, score) => {
      const on = agent?.address === a.address;
      return h_flex().id(`sd-${a.address}`).h(36).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(on ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pick = a.address; this.confirm = false; cx.notify(); })
        .child(div().w(8).h(8).flex_none().rounded(4).bg(color[a.status] ?? t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(`${a.program?.name ?? a.app ?? "agent"} · ${a.space_name} / ${a.tab_name}`))
        .child(div().flex_none().text_size(11).text_color(score >= 2 ? t.ansi2 : t.dim).child(score >= 3 ? "在這個專案" : score === 2 ? "同一個 space" : a.status));
    };
    const note = this.confirm && agent ? `${agent.program?.name ?? "agent"} 目前是 ${agent.status}，文字會直接打進它的輸入框。再按一次送出。` : this.error ?? null;

    return v_flex().id("send-dialog").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().flex_none().px(16).py(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(this.title))
        .child(button("sd-close", "✕ Esc", true, () => closeOverlay(this.overlay))))
      .child(v_flex().flex_1().min_h(0).gap(10).p(16)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("送給"))
        .child(list.length
          ? v_flex().id("sd-agents").flex_none().max_h(150).overflow_y_scrollbar().gap(2).children(list.map((x) => row(x.agent, x.score)))
          : v_flex().gap(8)
            .child(div().text_size(12.5).text_color(t.muted).child("目前沒有執行中的 agent。可以啟動一個，訊息會成為它的第一個任務："))
            .child(h_flex().gap(8).children((this.known ?? []).map((p, i) => button(`sd-start-${i}`, `啟動 ${p.name}`, this.ready(), (_e, cx) => this.start(p, cx), true))))
            .when(this.known && !this.known.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("找不到已安裝的 agent。"))))
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(this.ask ? "你的問題" : "補充說明"))
        .child(div().flex_none().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background).px(10).py(6)
          .child(Textarea.new(this.noteInput).w_full().text_size(13).text_color(t.foreground)))
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("將送出的內容"))
        .child(div().id("sd-preview").flex_1().min_h(0).overflow_y_scrollbar().rounded(6).bg(t.surface).border_1().border_color(t.border).p(10)
          .text_size(12).font_family("JetBrains Mono").text_color(t.muted).child(this.text)))
      .child(h_flex().flex_none().px(16).py(10).gap(10).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.error ? t.ansi1 : this.confirm ? t.blocked : t.dim)
          .child(note ?? (agent ? "Cmd/Ctrl+Enter 送出" : "")))
        .child(button("sd-send", this.sending ? "送出中…" : busy && this.confirm ? "仍然送出" : "送出", Boolean(agent) && this.ready(), (_e, cx) => this.send(cx), true)));
  }
}
