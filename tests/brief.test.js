import { expect, test } from "bun:test";
import { prBrief, worktreeOf } from "../mods/git-remote/brief.js";

const pr = { repo: "o/r", number: 7, title: "t", url: "u", headRefName: "feat/x", baseRefName: "main", body: "b" };
const local = { folder: "/code/r", branch: "main", worktrees: [{ path: "/code/r", branch: "main" }, { path: "/wt/feat-x", branch: "feat/x" }] };

test("worktreeOf finds the worktree that has the branch checked out", () => {
  expect(worktreeOf(local, "feat/x")).toEqual({ path: "/wt/feat-x", branch: "feat/x" });
  expect(worktreeOf(local, "other")).toBeNull();
  expect(worktreeOf({ folder: "/code/r" }, "feat/x")).toBeNull();
});

test("a PR brief names the worktree and does not tell the agent to check the branch out", () => {
  const text = prBrief(pr, { local });
  expect(text).toContain("/wt/feat-x");
  expect(text).toContain("Do NOT run `gh pr checkout`");
  expect(text).not.toContain("1. Get the branch");
});

test("without such a worktree the brief still tells the agent to check the PR out", () => {
  const text = prBrief(pr, { local: { folder: "/code/r", worktrees: [{ path: "/code/r", branch: "main" }] } });
  expect(text).toContain("1. Get the branch: `gh pr checkout 7`");
});
