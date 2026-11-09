// Enhanced Spaces + Worktrees sidebar mod (`spaces-plus`):
// - Groups linked worktrees under their parent Space (supports multi-repo umbrella folders as well as direct git repos)
// - Shows live Agent status (e.g. omp working/blocked/done) directly on Space & Worktree rows
// - Shows the currently bound GitHub Issue / task on Worktrees (and Spaces), clickable to switch/rebind at any time
// - Automatically cleans up closed clean worktrees in the background and prompts only when dirty/unpushed

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces,
  machines,
  panes,
  agents,
  run,
  openOverlay,
  exec,
  hc,
  home,
  theme,
  shared,
  setShared,
  watchFolder,
  window,
  layout,
} from "herdr";

const wtHelper = () => `${home()}/.config/herdr-app/mods/worktree-plus/wt-helper.py`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const FALLBACK = 60000;

const MARK = {
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
};

const STATUS_RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

function repoMainPath(repoKey) {
  if (!repoKey) return null;
  try {
    const [, gitDir] = JSON.parse(repoKey);
    if (!gitDir) return null;
    return gitDir.endsWith("/.git") ? gitDir.slice(0, -5) : gitDir;
  } catch {
    return null;
  }
}

export default class SpacesPlus extends View {
  init(_props, cx) {
    this.git = {};
    this.checked = {};
    this.unsure = new Set();
    this.pending = new Set();
    this.busy = {};
    this.ready = {};
    this.at = {};
    this.watching = new Set();
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.scanningWt = false;
    this.lastWtSig = "";
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.agentsFolded = new Set(JSON.parse(localStorage.getItem("spaces.agents.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    cx.timer.every(250, (cx) => this.checkNew(cx));
    cx.timer.every(1000, () => this.checkClosedWorktrees());
  }

  async checkClosedWorktrees() {
    if (this.scanningWt) return;
    const sp = spaces();
    const pn = panes();
    const sig =
      sp.map((s) => `${s.id}:${s.folder ?? ""}`).join("|") +
      "::" +
      pn.map((p) => `${p.pane}:${p.cwd ?? ""}`).join("|");
    if (sig === this.lastWtSig) return;
    this.lastWtSig = sig;

    this.scanningWt = true;
    try {
      const openPaths = [...sp.map((s) => s.folder), ...pn.map((p) => p.cwd)].filter(Boolean);
      const r = await exec("python3", [wtHelper(), "scan-orphans", JSON.stringify(openPaths)], { timeout: 120000 });
      if (r.code === 0 && r.stdout.trim()) {
        const res = JSON.parse(r.stdout);
        if (Array.isArray(res.cleaned) && res.cleaned.length > 0) {
          const meta = { ...(shared("worktree-plus.meta") ?? {}) };
          let changed = false;
          for (const c of res.cleaned) {
            const k = c.replace(/\/+$/, "");
            if (k in meta) {
              delete meta[k];
              changed = true;
            }
          }
          if (changed) setShared("worktree-plus.meta", meta);
        }
        if (res.prompt && !shared("worktree-plus.request")) {
          setShared("worktree-plus.request", { action: "remove", folder: res.prompt });
          run("mod.open", { name: "worktree-plus" });
        }
      }
    } catch {}
    this.scanningWt = false;
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  due(now, sp, ps) {
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of this.agentKeys(sp, ps)) keys.add(k);
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at))
      if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane])
        this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false)
        for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK)
          due.add(k);
      }
    }
    return due;
  }

  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0)
          this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return (
      machine?.state === "unreachable" &&
      /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "")
    );
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = (this.reconnecting[name] ??= { machine, removed: false });
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const ask = async (args) => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try {
              error = JSON.parse(r.stdout || r.stderr).error?.message;
            } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(
        Object.values(this.git)
          .filter(Boolean)
          .map((g) => JSON.parse(g.repo))
          .filter(([on]) => !on)
          .map(([, repo]) => repo)
      );
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      const r = await exec(
        "git",
        ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"],
        { cwd, on }
      );
      if (r.code !== 0) {
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd,
        on,
      });
      const gitDir = await exec("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const topPath = top.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = {
        name,
        top: topPath,
        branch: null,
        ahead: 0,
        behind: 0,
        repo: JSON.stringify([on, repo]),
        // A linked worktree has its own git dir apart from the shared one; a repo whose .git lives elsewhere
        // (--separate-git-dir) does not.
        linked: gitDir.stdout.trim() !== repo,
      };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo))
            this.refreshGit(
              Object.keys(this.git).filter((k) => this.git[k]?.repo === mine),
              cx
            );
        }
      } catch {
        this.watching.delete(repo);
      }
    });
  }

  menu(w) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  openIssuePicker(w, cwd) {
    setShared("worktree-plus.request", {
      action: "issue",
      space: w.id,
      folder: cwd || w.folder,
    });
    run("mod.open", { name: "worktree-plus" });
  }

  openNewWorktree() {
    const active = spaces().find((s) => s.active);
    const ps = panes();
    setShared("worktree-plus.request", {
      action: "new",
      space: active?.id ?? null,
      folder: active ? place(active, ps) : null,
    });
    run("mod.open", { name: "worktree-plus" });
  }

  // Find which parent Space a linked worktree row `k` belongs under.
  findParentId(k, mainsList, meta) {
    const kFolder = (k.cwd || k.w.folder || "").replace(/\/+$/, "");
    const m = meta[kFolder] ?? meta[k.g?.top?.replace(/\/+$/, "") ?? ""];
    if (m?.parentSpaceId && mainsList.some((r) => r.w.id === m.parentSpaceId)) {
      return m.parentSpaceId;
    }
    // 1. Direct git repo match
    const direct = mainsList.find((r) => r.g && r.g.repo === k.g.repo);
    if (direct) return direct.w.id;
    // 2. Space name matches repo name (e.g. Space "CMS" for repo "CMS")
    if (k.g?.name) {
      const byName = mainsList.find((r) => r.w.name.toLowerCase() === k.g.name.toLowerCase());
      if (byName) return byName.w.id;
    }
    // 3. Umbrella workspace folder match (e.g. parent Space folder contains child git repo)
    const mainRepoDir = repoMainPath(k.g?.repo);
    if (mainRepoDir) {
      const umbrella = mainsList.find((r) => {
        const rf = (r.w.folder || r.cwd || "").replace(/\/+$/, "");
        const h = home();
        return rf && rf !== h && mainRepoDir.startsWith(rf + "/");
      });
      if (umbrella) return umbrella.w.id;
    }
    return null;
  }

  ordered() {
    const sp = spaces();
    const ps = panes();
    const meta = shared("worktree-plus.meta") ?? {};
    const ready = (w) =>
      this.shown.has(w.id) ||
      where(w, ps) in this.git ||
      Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);

    const list = sp
      .map((w, i) => {
        const cwd = place(w, ps);
        const g = this.git[where(w, ps)] ?? null;
        const isWtPath = (w.folder || "").includes("/.herdr/worktrees/");
        return { w, i, cwd, g, isWt: Boolean(g?.linked || isWtPath) };
      })
      .filter((r) => this.shown.has(r.w.id));

    const mainsList = list.filter((r) => !r.isWt);
    const parentMap = new Map(); // parentSpaceId -> child rows[]
    const unparentedWts = [];

    for (const r of list) {
      if (!r.isWt) continue;
      const pid = this.findParentId(r, mainsList, meta);
      if (pid) {
        const arr = parentMap.get(pid) ?? [];
        arr.push(r);
        parentMap.set(pid, arr);
      } else {
        unparentedWts.push(r);
      }
    }

    const out = [];
    for (const r of mainsList) {
      out.push({ ...r, tree: null });
      const kids = parentMap.get(r.w.id) ?? [];
      kids.forEach((k, n) =>
        out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" })
      );
    }
    for (const u of unparentedWts) {
      out.push({ ...u, tree: "└─" });
    }
    return out;
  }

  resolveIssue(w, cwd, g) {
    const meta = shared("worktree-plus.meta") ?? {};
    const cleanCwd = (cwd || "").replace(/\/+$/, "");
    const cleanFolder = (w.folder || "").replace(/\/+$/, "");
    const cleanTop = (g?.top || "").replace(/\/+$/, "");
    const entry =
      meta[cleanTop] ??
      meta[cleanFolder] ??
      meta[cleanCwd] ??
      meta[`space:${w.id}`] ??
      null;
    if (entry?.issue) return entry.issue;

    // Auto-infer issue number if branch name contains issue-<N>
    const br = g?.branch || w.name || "";
    const m = br.match(/(?:issue-|#)(\d+)/i);
    if (m) {
      return { number: parseInt(m[1], 10), title: br };
    }
    return null;
  }

  // Git lookup keys for the cwd of every agent's pane, so each agent can be told apart: linked worktree or plain path.
  agentKeys(sp, ps) {
    const machine = Object.fromEntries(sp.map((s) => [s.id, s.machine ?? null]));
    const cwd = Object.fromEntries(ps.map((p) => [p.pane, p.cwd]));
    return agents().flatMap((a) =>
      a.space in machine && cwd[a.pane] ? [JSON.stringify([machine[a.space], cwd[a.pane]])] : []
    );
  }

  toggleAgents(id, cx) {
    this.agentsFolded.has(id) ? this.agentsFolded.delete(id) : this.agentsFolded.add(id);
    localStorage.setItem("spaces.agents.folded", JSON.stringify([...this.agentsFolded]));
    cx.notify();
  }

  shortPath(cwd, w) {
    const folder = (w.folder || "").replace(/\/+$/, "");
    if (folder && cwd === folder) return base(folder) || "/";
    if (folder && cwd.startsWith(`${folder}/`)) return cwd.slice(folder.length + 1);
    const h = home();
    return h && cwd.startsWith(`${h}/`) ? `~${cwd.slice(h.length)}` : cwd;
  }

  // One row per agent under a Space holding two or more: status, name, and `wt` (linked worktree, with its branch)
  // or `path` (plain checkout, shown relative to the Space folder).
  agentRows({ w, tree }, allAgents, ps, t) {
    const mine = allAgents.filter((a) => a.space === w.id);
    if (mine.length < 2 || this.agentsFolded.has(w.id)) return [];
    const cwdOf = Object.fromEntries(ps.map((p) => [p.pane, p.cwd]));
    return [...mine]
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((a) => {
        const cwd = cwdOf[a.pane] ?? "";
        const g = this.git[JSON.stringify([w.machine ?? null, cwd])];
        const wt = g ? Boolean(g.linked) : cwd.includes("/.herdr/worktrees/");
        const label = wt ? g?.branch || base(cwd) : cwd ? this.shortPath(cwd, w) : "?";
        const name = (a.app || a.program?.name || "agent").replace(/-code$/, "");
        const program = a.program?.icon ? a.program : ps.find((p) => p.pane === a.pane)?.program;
        return h_flex()
          .id(`agent-${a.address}`)
          .h(22)
          .flex_none()
          .pl(tree ? 43 : 25)
          .pr(4)
          .gap(6)
          .items_center()
          .rounded(6)
          .text_size(11)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(cwd || name)
          .on_click(() => {
            run("space.select", { id: w.id });
            if (a.tab) run("tab.select", { id: a.tab });
            run("pane.focus", { terminal: a.address });
          })
          .child(div().size(6).rounded(3).flex_none().bg(tone(t, a.status)))
          .child(
            program?.icon
              ? program.tint
                ? svg(program.icon).size(14).flex_none().text_color(t.muted)
                : image(program.icon).size(14).flex_none()
              : svg("icons/agent.svg").size(14).flex_none().text_color(t.muted)
          )
          .child(
            div()
              .flex_none()
              .text_size(10.5)
              .text_color(a.status === "working" ? t.foreground : t.muted)
              .child(name)
          )
          .child(
            div()
              .flex_none()
              .px(4)
              .rounded(4)
              .bg(t.surface)
              .text_size(10)
              .text_color(wt ? t.accent : t.dim)
              .child(wt ? "wt" : "path")
          )
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(label));
      });
  }

  resolveAgentSummary(w, allAgents) {
    const mine = allAgents.filter((a) => a.space === w.id);
    if (!mine.length) return null;
    const sorted = [...mine].sort(
      (a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0)
    );
    const top = sorted[0];
    const name = top.app || top.program?.name || "agent";
    const shortName = name.replace(/-code$/, "");
    return {
      count: mine.length,
      space: w.id,
      name: shortName,
      status: top.status,
      address: top.address,
    };
  }

  grouped(t, collapsed) {
    const rows = this.ordered();
    const allAgents = agents();
    const ps = panes();
    const draw = (r) =>
      collapsed
        ? [this.compact(r, t)]
        : [this.row(r, t, allAgents), ...this.agentRows(r, allAgents, ps, t)];
    const remote = [
      ...new Set([
        ...rows.map((r) => r.w.machine).filter(Boolean),
        ...this.machines.map((m) => m.name),
        ...Object.keys(this.reconnecting),
      ]),
    ].sort();
    const loading = (m) => {
      const layout = machines().find((k) => k.name === m)?.layout;
      return (
        layout === "loading" ||
        (!layout && this.machines.some((k) => k.name === m && k.state === "connected")) ||
        spaces().some((s) => (s.machine ?? null) === m && !this.shown.has(s.id))
      );
    };
    const loadingRow = (m) =>
      div()
        .id(`machine-loading-${m ?? "local"}`)
        .h(28)
        .flex_none()
        .px(8)
        .text_size(12)
        .text_color(t.dim)
        .child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find((k) => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex()
        .id(`machine-${m ?? "local"}`)
        .h(26)
        .flex_none()
        .px(collapsed ? 2 : 8)
        .gap(7)
        .items_center()
        .text_size(11)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, (el) =>
          el
            .child(div().flex_1().truncate().child(m ?? "This computer"))
            .when(!connected && !rebuilt, (el) =>
              el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " ")))
            )
            .when(rebuilt, (el) =>
              el.child(
                h_flex()
                  .flex_none()
                  .gap(3)
                  .items_center()
                  .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
                  .child(
                    div()
                      .id(`machine-connect-${m}`)
                      .text_color(repair?.error ? t.blocked : t.muted)
                      .hover((s) => s.text_color(t.foreground))
                      .tooltip(
                        repair?.error ||
                          "This machine was rebuilt or replaced. Click to connect to the new one."
                      )
                      .on_click((_e, cx) => {
                        cx.stop_propagation();
                        this.reconnect(machine, cx);
                      })
                      .child(repair?.busy ? "Connecting…" : "Connect")
                  )
              )
            )
            .when(connected, (el) =>
              el.child(
                div()
                  .id(`machine-add-${m ?? "local"}`)
                  .flex_none()
                  .px(4)
                  .rounded(4)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    run("space.new", { machine: m ?? "" });
                  })
                  .child("+")
              )
            )
            .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
            .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none())
        );
      const empty = h_flex()
        .id(`machine-new-${m ?? "local"}`)
        .h(28)
        .flex_none()
        .px(8)
        .gap(7)
        .items_center()
        .rounded(7)
        .text_size(12)
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12))
        .when(!collapsed, (el) => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [
        head,
        ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : empty]),
      ];
    });
  }

  gitTail(g, tree, name, ag, t) {
    const raw = g?.branch ?? "";
    const same = (a) => a && a.toLowerCase() === name.toLowerCase();
    const branch = !raw || same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = !g?.name || same(g.name) ? "" : g.name;
    const where = tree ? (repo || branch) : [repo, branch].filter(Boolean).join(" · ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11)
      .text_color(t.dim)
      .when(Boolean(ag), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .gap(3)
            .items_center()
            .px(4)
            .py(1)
            .rounded(4)
            .bg(t.surface)
            .when(ag.count > 1, (b) =>
              b
                .id(`space-agents-${ag.space}`)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .tooltip("展開 / 收合 agent 清單")
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.toggleAgents(ag.space, cx);
                })
            )
            .child(div().size(6).rounded(3).bg(tone(t, ag.status)))
            .child(
              div()
                .text_size(10.5)
                .text_color(ag.status === "working" ? t.foreground : t.muted)
                .child(
                  `${ag.count > 1 ? (this.agentsFolded.has(ag.space) ? "▸ " : "▾ ") : ""}${ag.name}${ag.count > 1 ? `×${ag.count}` : ""}`
                )
            )
        )
      )
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(Boolean(g && g.ahead > 0), (el) =>
        el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`))
      )
      .when(Boolean(g && g.behind > 0), (el) =>
        el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`))
      );
  }

  row({ w, i, cwd, g, tree, isWt }, t, allAgents) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
    const ag = this.resolveAgentSummary(w, allAgents);
    const issue = this.resolveIssue(w, cwd, g);
    const showSecondLine = Boolean(isWt || issue);
    const height = showSecondLine ? 46 : 30;

    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(height)
      .flex_none()
      .justify_center()
      .gap(2)
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) =>
        el.child(
          div()
            .absolute()
            .left(0)
            .right(0)
            .h(2)
            .bg(t.accent)
            .when(this.pressed < i, (line) => line.bottom(0))
            .when(this.pressed > i, (line) => line.top(0))
        )
      )
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i)
          run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .when(Boolean(tree), (el) =>
            el.pl(18).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.accent))
          )
          .when(!tree, (el) =>
            el.child(
              h_flex()
                .size(18)
                .flex_none()
                .rounded(5)
                .bg(fill)
                .items_center()
                .justify_center()
                .text_size(10.5)
                .font_bold()
                .text_color("#ffffff")
                .child([...w.name][0]?.toUpperCase() ?? "?")
            )
          )
          .child(div().flex_shrink(0).max_w(125).truncate().text_color(t.foreground).child(w.name))
          .child(this.gitTail(g, tree, w.name, ag, t))
      )
      .when(showSecondLine, (el) =>
        el.child(
          h_flex()
            .pl(tree ? 36 : 25)
            .pr(2)
            .items_center()
            .child(
              h_flex()
                .id(`space-issue-${w.id}`)
                .max_w(215)
                .px(5)
                .py(1)
                .gap(4)
                .rounded(4)
                .items_center()
                .cursor_pointer()
                .bg(issue ? t.surface : "#00000000")
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip("點擊切換 / 綁定此 Worktree 目前處理的 GitHub Issue (或按 Ctrl+A 接 i)")
                .on_mouse_down("left", (_e, cx) => {
                  cx.stop_propagation();
                })
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.openIssuePicker(w, cwd);
                })
                .child(
                  div()
                    .truncate()
                    .text_size(10.5)
                    .text_color(issue ? t.accent : t.dim)
                    .child(
                      issue
                        ? `🎯 ${issue.number ? `#${issue.number} ` : ""}${issue.title}`
                        : "+ 綁定處理中的 Issue…"
                    )
                )
            )
        )
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map((p) => p.id));
    const kept = Object.fromEntries(
      Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id))
    );
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[p.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .child(
        h_flex()
          .h(31)
          .pl(16)
          .pr(10)
          .items_center()
          .justify_between()
          .text_size(11.5)
          .text_color(t.dim)
          .when(!collapsed, (el) => el.child("Spaces & Worktrees"))
          .child(
            h_flex()
              .gap(2)
              .items_center()
              .child(
                div()
                  .id("space-new-wt")
                  .size(26)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(6)
                  .tooltip("新建 Git Worktree (Ctrl+A 接 G)")
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click(() => this.openNewWorktree())
                  .child(svg("mods/workspace-chrome/branch.svg").size(13))
              )
              .child(
                div()
                  .id("space-new")
                  .size(26)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(6)
                  .tooltip("新建 Space (Ctrl+A 接 N)")
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click(() => run("space.new"))
                  .child(svg("mods/workspace-chrome/plus.svg").size(14))
              )
          )
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .px(8)
          .pb(14)
          .overflow_y_scrollbar()
          .mode("always")
          .on_mouse_up("left", (_e, cx) => {
            this.pressed = null;
            cx.notify();
          })
          .children(this.grouped(t, collapsed))
      );
  }
}
