import { describe, expect, test } from "bun:test";
import { nest, parentOf, pinFirst, pinKey } from "../mods/spaces-plus/nest.js";
import { mainTop, parseBranch, repoInfo } from "../mods/spaces-plus/repo.js";

const info = (top, common, gitDir = common, on = null) => repoInfo({ on, top, common, gitDir });
const space = (id, name, folder, g = null, extra = {}) => ({ w: { id, name, folder, machine: null, ...extra }, i: 0, cwd: folder, g });
const ids = (rows) => rows.map((r) => `${r.tree ?? ""}${r.w.id}`);

describe("repoInfo", () => {
  test("a repo with .git inside the checkout is not linked", () => {
    expect(info("/code/r", "/code/r/.git")).toMatchObject({ name: "r", linked: false });
  });
  test("a repo whose .git lives elsewhere (--separate-git-dir) is not linked", () => {
    expect(info("/vault/wiki", "/store/wiki.git")).toMatchObject({ name: "wiki", linked: false });
  });
  test("a linked worktree has its own git dir apart from the shared one", () => {
    expect(info("/wt/x", "/code/r/.git", "/code/r/.git/worktrees/x")).toMatchObject({ name: "r", linked: true });
  });
  test("the repo key names the machine", () => {
    expect(info("/c", "/c/.git", "/c/.git", "mini").repo).toBe('["mini","/c/.git"]');
  });
});

test("parseBranch reads the branch and how far it is from its upstream", () => {
  expect(parseBranch("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -2\n")).toEqual({ branch: "main", ahead: 1, behind: 2 });
  expect(parseBranch("# branch.head (detached)\n")).toEqual({ branch: "(detached)", ahead: 0, behind: 0 });
});

test("mainTop is the checkout for a repo key with .git inside it, else null", () => {
  expect(mainTop('[null,"/code/r/.git"]')).toBe("/code/r");
  expect(mainTop('[null,"/store/r.git"]')).toBeNull();
  expect(mainTop(undefined)).toBeNull();
});

describe("nest", () => {
  const repo = "/code/r/.git";
  const main = space("main", "r", "/code/r", info("/code/r", repo));
  const wt = (id, branch = id, folder = `/wt/${id}`) => space(id, branch, folder, info(folder, repo, `${repo}/worktrees/${id}`));

  test("a worktree sits under the main Space on the same repo", () => {
    expect(ids(nest([wt("a"), main, wt("b")]))).toEqual(["main", "├─a", "└─b"]);
  });

  test("Spaces that are not worktrees keep their order and get no tree mark", () => {
    const other = space("o", "o", "/code/o", info("/code/o", "/code/o/.git"));
    expect(ids(nest([other, main]))).toEqual(["o", "main"]);
  });

  test("a worktree on another machine never goes under this machine's Space", () => {
    const remote = space("far", "x", "/wt/x", info("/wt/x", repo, `${repo}/worktrees/x`), { machine: "mini" });
    expect(ids(nest([main, remote]))).toEqual(["main", "└─far"]);
  });

  test("the Space a worktree was opened from wins over the same-repo Space", () => {
    const sibling = space("sib", "sib", "/code/sib", info("/code/sib", "/code/sib/.git"));
    const meta = { "/wt/a": { parentSpaceId: "sib" } };
    expect(ids(nest([main, sibling, wt("a")], { meta }))).toEqual(["main", "sib", "└─a"]);
  });

  test("a Space named like the repo adopts a worktree when its own git info is missing", () => {
    const named = space("n", "R", "/code/r", null);
    expect(ids(nest([named, wt("a")]))).toEqual(["n", "└─a"]);
  });

  test("an umbrella folder holding the repo adopts its worktrees", () => {
    const umbrella = space("u", "umbrella", "/code", null);
    expect(ids(nest([umbrella, wt("a")]))).toEqual(["u", "└─a"]);
  });

  test("home is never an umbrella", () => {
    const home = space("h", "me", "/Users/me", null);
    const a = space("a", "a", "/wt/a", info("/wt/a", "/Users/me/code/r/.git", "/Users/me/code/r/.git/worktrees/a"));
    expect(parentOf(a, [home], { home: "/Users/me" })).toBeNull();
    expect(parentOf(a, [home], { home: "/elsewhere" })).toBe(home);
  });

  test("worktrees of a repo that is not open stand under one ghost row; a lone one stays flat", () => {
    const [ghost, ...rest] = nest([wt("a"), wt("b")]);
    expect(ghost).toMatchObject({ ghost: true, w: { name: "r", folder: "/code/r", machine: null } });
    expect(ids(rest)).toEqual(["├─a", "└─b"]);
    expect(ids(nest([wt("a")]))).toEqual(["└─a"]);
  });

  test("a folder under ~/.herdr/worktrees counts as a worktree even before git has answered", () => {
    const pending = space("p", "p", "/Users/me/.herdr/worktrees/r/x", null);
    expect(() => nest([main, pending])).not.toThrow();
    expect(ids(nest([main, pending]))).toEqual(["main", "└─p"]);
  });
});

describe("pinFirst", () => {
  const row = (id, tree = null, extra = {}) => ({ w: { id, name: id, folder: `/f/${id}`, machine: null }, tree, ...extra });
  const pins = (...ids) => new Set(ids.map((id) => pinKey(row(id).w)));

  test("pinned Spaces move to the top with their worktrees; everything else keeps its order", () => {
    const rows = [row("a"), row("b"), row("b1", "└─"), row("c")];
    expect(ids(pinFirst(rows, pins("b")))).toEqual(["b", "└─b1", "a", "c"]);
    expect(ids(pinFirst(rows, pins("c", "a")))).toEqual(["a", "c", "b", "└─b1"]);
  });

  test("pinning a worktree row does nothing: only a top-level Space is pinned", () => {
    const rows = [row("a"), row("a1", "└─"), row("b")];
    expect(ids(pinFirst(rows, pins("a1")))).toEqual(["a", "└─a1", "b"]);
  });

  test("a ghost row is never pinned", () => {
    const rows = [row("a"), row("g", null, { ghost: true }), row("g1", "└─")];
    expect(ids(pinFirst(rows, pins("g")))).toEqual(["a", "g", "└─g1"]);
  });

  test("Spaces in the same folder are pinned separately", () => {
    const rows = [row("a", null, { w: { id: "a", folder: "/home" } }), row("b", null, { w: { id: "b", folder: "/home" } })];
    expect(ids(pinFirst(rows, new Set(["b"])))).toEqual(["b", "a"]);
  });
});
