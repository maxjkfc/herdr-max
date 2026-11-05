// The changed-files column as a folder tree: file list [{ path, add, del, binary }] → flat rows for a virtual list.
// Rows are { type: "dir", key: "d:<path>", path, name, depth, open, count } and
// { type: "file", key: "f:<index into files>", idx, name, dir, depth, f }. A folder holding only one folder is
// shown joined with it ("mods/git-graph"). A filter keeps matching paths only and opens every folder on the way.
// Keep mods/git-graph/filetree.js and mods/git-remote/filetree.js identical: a mod cannot import another mod's files.
export function treeRows(files, collapsed, filter = "") {
  const q = filter.trim().toLowerCase();
  const root = { dirs: new Map(), files: [] };
  files.forEach((f, idx) => {
    if (q && !f.path.toLowerCase().includes(q)) return;
    const parts = f.path.split("/"), name = parts.pop();
    let n = root;
    for (const p of parts) {
      if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), files: [] });
      n = n.dirs.get(p);
    }
    n.files.push({ idx, name, f });
  });
  const count = (n) => n.files.length + [...n.dirs.values()].reduce((s, d) => s + count(d), 0);
  const rows = [];
  const walk = (n, prefix, depth) => {
    for (const [first, node] of [...n.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      let name = first, d = node;
      while (d.files.length === 0 && d.dirs.size === 1) { const [k, v] = [...d.dirs][0]; name += `/${k}`; d = v; }
      const path = prefix + name, open = Boolean(q) || !collapsed.has(path);
      rows.push({ type: "dir", key: `d:${path}`, path, name, depth, open, count: count(d) });
      if (open) walk(d, `${path}/`, depth + 1);
    }
    for (const x of n.files.sort((a, b) => a.name.localeCompare(b.name))) rows.push({ type: "file", key: `f:${x.idx}`, idx: x.idx, name: x.name, depth, f: x.f });
  };
  walk(root, "", 0);
  return rows;
}
