import { agents, panes, spaces, focused, hc, run } from "herdr";

// Starting a coding agent for some work, shared by the PR panel's 派發 Agent and the review dialog's 啟動 (a mod can't import
// another mod's files: mods/review/startagent.js is a copy, see scripts/check-mirrors.sh).
//
// It always lands in the space being looked at (`focused().space`): a space picked from where the repo's checkout was
// found could be another one, or one that no longer exists ("no space ..."). Beside a terminal of the repo in that space
// it is a split pane to the right (pane.split takes no task, so `text` is sent with `hc send` once the agent is up);
// with no such terminal, or on another machine, it is a tab of that space with `text` as its first task.
//
//   startAgent(prog, { root, on, name, text, cx, done })   done(error?) once the text is in (error: why it isn't)
export function startAgent(prog, { root, on, name, text, cx, done }) {
  const cur = focused();
  const tabs = new Set((spaces().find((s) => s.id === cur?.space)?.tabs ?? []).map((t) => t.id));
  const dir = root?.replace(/\/+$/, "");
  const inRepo = (p) => dir && p.terminal && p.cwd && (p.cwd === dir || p.cwd.startsWith(`${dir}/`));
  const all = panes(), here = all.filter((p) => tabs.has(p.tab));
  const target = on ? null : here.find((p) => p.focused && inRepo(p)) ?? here.find((p) => p.tab === cur?.tab && inRepo(p)) ?? here.find(inRepo);
  if (!target) {
    run("tab.new", { name: name.slice(0, 48), ...(cur?.space ? { space: cur.space } : {}), ...(root ? { folder: root } : {}), argv: prog.run, task: text });
    done();
    return;
  }
  const before = new Set(all.map((p) => p.pane));
  run("pane.split", { direction: "right", pane: target.pane, argv: prog.run });
  // The new pane, then its agent (first sign of life), then a moment for its prompt before the text goes in.
  // Not every program shows up in agents() (no status reporting): once the pane exists, give the agent 10 s to be
  // recognised, then send into the pane anyway. Only a pane that never appears is an error.
  let tries = 0, address = null;
  const send = (cx) => cx.timer.after(1500, () => {
    hc(["send", address, text])
      .then((r) => done(r.code === 0 ? undefined : (r.stderr || r.stdout).trim().slice(0, 300) || "hc send 失敗"))
      .catch((e) => done(String(e).slice(0, 300)));
  });
  const wait = (cx) => {
    if (!address) {
      if (++tries > 60) { done("新的 pane 沒有在 30 秒內出現，訊息沒有送出"); return; }
      address = panes().find((p) => p.terminal && !before.has(p.pane))?.terminal ?? null;
      if (!address) { cx.timer.after(500, wait); return; }
      tries = 0;
    }
    if (agents().some((a) => a.address === address) || ++tries > 20) send(cx);
    else cx.timer.after(500, wait);
  };
  cx.timer.after(500, wait);
}
