import { describe, expect, test } from "bun:test";
import { dirtyCount, nameOf, parseWorktrees } from "../mods/review/worktrees.js";

describe("parseWorktrees", () => {
  const text = [
    "worktree /Users/me/code/app", "HEAD 1111", "branch refs/heads/main", "",
    "worktree /Users/me/.herdr/worktrees/app/feat-x", "HEAD 2222", "branch refs/heads/feat/x", "",
    "worktree /tmp/detached", "HEAD 3333", "detached", "",
    "worktree /tmp/bare", "bare", "",
    "worktree /tmp/gone", "HEAD 4444", "branch refs/heads/old", "prunable gitdir file points to non-existent location", "",
  ].join("\n");
  test("branch names lose refs/heads/, detached ones have none, bare and prunable are dropped", () => {
    expect(parseWorktrees(text).map((w) => [w.path, w.branch, w.detached])).toEqual([
      ["/Users/me/code/app", "main", false],
      ["/Users/me/.herdr/worktrees/app/feat-x", "feat/x", false],
      ["/tmp/detached", null, true],
    ]);
  });
  test("a single worktree, and empty or garbage output", () => {
    expect(parseWorktrees("worktree /a\nHEAD 1\nbranch refs/heads/m\n")).toHaveLength(1);
    expect(parseWorktrees("")).toEqual([]);
    expect(parseWorktrees("fatal: not a git repository")).toEqual([]);
  });
});

describe("dirtyCount / nameOf", () => {
  test("one record per path", () => {
    expect(dirtyCount(" M a.js\0?? b/c.txt\0")).toBe(2);
    expect(dirtyCount("")).toBe(0);
  });
  test("the last path segment, tolerating a trailing slash", () => {
    expect(nameOf("/Users/me/.herdr/worktrees/app/feat-x")).toBe("feat-x");
    expect(nameOf("/a/b/")).toBe("b");
    expect(nameOf("/")).toBe("/");
  });
});
