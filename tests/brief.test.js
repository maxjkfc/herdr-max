import { expect, test } from "bun:test";
import { prBrief, worktreeOf } from "../mods/git-remote/brief.js";

const pr = { repo: "o/r", number: 7, title: "t", url: "u", headRefName: "feat/x", baseRefName: "main", body: "b" };
const local = { folder: "/code/r", branch: "main", worktrees: [{ path: "/code/r", branch: "main" }, { path: "/wt/feat-x", branch: "feat/x" }] };

test("worktreeOf finds the worktree that has the branch checked out", () => {
  expect(worktreeOf(local, pr)).toEqual({ path: "/wt/feat-x", branch: "feat/x" });
  expect(worktreeOf(local, { headRefName: "other" })).toBeNull();
  expect(worktreeOf({ folder: "/code/r" }, pr)).toBeNull();
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

test("a fork PR never uses a local worktree, even when the branch name matches", () => {
  const fork = { ...pr, isCrossRepository: true };
  expect(worktreeOf(local, fork)).toBeNull();
  expect(prBrief(fork, { local })).toContain("1. Get the branch: `gh pr checkout 7`");
});

test("a PR with nothing failing is a read-only review with a findings report", () => {
  const text = prBrief(pr, { local });
  expect(text).toContain("Mode: REVIEW ONLY");
  expect(text).toContain("Do not edit, create or delete files");
  expect(text).toContain("[P0-P3] file:line");
  expect(text).not.toContain("Local commits per the Rules");
});

test("failing checks or requested changes switch the brief to fix mode", () => {
  const failing = prBrief({ ...pr, checks: { state: "FAILURE", failed: [{ name: "test", conclusion: "failure" }] } }, { local });
  const changes = prBrief({ ...pr, reviewDecision: "CHANGES_REQUESTED" }, { local });
  for (const text of [failing, changes]) {
    expect(text).toContain("Mode: FIX");
    expect(text).toContain("Local commits per the Rules");
    expect(text).not.toContain("REVIEW ONLY");
  }
});
