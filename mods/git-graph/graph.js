// Lane layout for a commit list in topological order (every child before its parents,
// as `git log --topo-order` / `--date-order` prints it).
//
// Each row is one commit. A lane is a column that is waiting for one commit hash.
// `segs` are the line pieces drawn inside the row's cell, in lane units on x and in
// row fractions on y: 0 = top edge, 0.5 = the commit dot, 1 = bottom edge.
// Colors are lane identities (`color`), mapped to a palette by the renderer.

export function layoutGraph(commits) {
  let lanes = [];
  let nextColor = 0;
  let width = 1;
  const rows = [];

  for (const c of commits) {
    const before = lanes;
    let node = before.findIndex((l) => l && l.hash === c.hash);
    let nodeColor;
    if (node === -1) {
      node = before.indexOf(null);
      if (node === -1) node = before.length;
      nodeColor = nextColor++;
    } else {
      nodeColor = before[node].color;
    }

    const segs = [];
    // Above the dot: lanes passing through, and lanes ending here.
    before.forEach((l, i) => {
      if (!l) return;
      if (l.hash === c.hash) segs.push({ x1: i, y1: 0, x2: node, y2: 0.5, color: l.color });
      else segs.push({ x1: i, y1: 0, x2: i, y2: 1, color: l.color });
    });

    const after = before.map((l) => (l && l.hash === c.hash ? null : l));
    // Below the dot: one line to each parent's lane.
    c.parents.forEach((p, k) => {
      const existing = after.findIndex((l) => l && l.hash === p);
      if (existing !== -1) {
        segs.push({ x1: node, y1: 0.5, x2: existing, y2: 1, color: after[existing].color });
        return;
      }
      let lane;
      if (k === 0) lane = node;
      else {
        lane = after.indexOf(null);
        if (lane === -1) lane = after.length;
      }
      const color = k === 0 ? nodeColor : nextColor++;
      after[lane] = { hash: p, color };
      segs.push({ x1: node, y1: 0.5, x2: lane, y2: 1, color });
    });
    while (after.length && after[after.length - 1] === null) after.pop();

    const used = Math.max(node + 1, before.length, after.length);
    if (used > width) width = used;
    rows.push({ commit: c, node, color: nodeColor, segs, merge: c.parents.length > 1 });
    lanes = after;
  }
  return { rows, width };
}

// `git log` fields, split by unit separator; records end with a record separator.
export const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e";

export function parseLog(text) {
  const commits = [];
  for (const rec of text.split("\x1e")) {
    const r = rec.replace(/^\n/, "");
    if (!r) continue;
    const [hash, parents, author, at, refs, subject] = r.split("\x1f");
    if (!hash) continue;
    commits.push({
      hash,
      parents: parents ? parents.split(" ") : [],
      author,
      time: Number(at) * 1000,
      refs: parseRefs(refs),
      subject: subject ?? "",
    });
  }
  return commits;
}

// "HEAD -> main, origin/main, tag: v1" -> [{kind, name}]
export function parseRefs(decoration) {
  if (!decoration) return [];
  const out = [];
  for (const part of decoration.split(", ")) {
    const p = part.trim();
    if (!p) continue;
    if (p === "HEAD") out.push({ kind: "head", name: "HEAD" });
    else if (p.startsWith("HEAD -> ")) out.push({ kind: "head", name: p.slice(8) });
    else if (p.startsWith("tag: ")) out.push({ kind: "tag", name: p.slice(5) });
    else if (p.endsWith("/HEAD")) continue;
    else out.push({ kind: p.includes("/") ? "remote" : "branch", name: p });
  }
  return out;
}

export function relativeTime(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}
