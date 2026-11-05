import { describe, expect, test } from "bun:test";
import { askMessage, findRow, lineLabel, locate, makeDraft, matchAgents, reviewMessage } from "../mods/review/drafts.js";

const rows = [
  { kind: "@", text: "@@ -1,3 +1,4 @@" },
  { kind: " ", number: 1, text: "keep" },
  { kind: "-", number: 2, text: "old line" },
  { kind: "+", number: 2, text: "new line" },
  { kind: "+", number: 3, text: "added" },
  { kind: " ", number: 4, text: "tail" },
];

describe("makeDraft", () => {
  test("quotes the lines, skips hunk headers, and needs text", () => {
    const d = makeDraft({ id: "1", path: "a.js", rows, from: 0, to: 3, body: "  fix this \n" });
    expect(d.body).toBe("fix this");
    expect(d.quote.map((l) => l.kind)).toEqual([" ", "-", "+"]);
    expect(d.first).toMatchObject({ kind: " ", number: 1 });
    expect(makeDraft({ id: "1", path: "a.js", rows, from: 0, to: 0, body: "x" })).toBeNull();
    expect(makeDraft({ id: "1", path: "a.js", rows, from: 1, to: 2, body: "  " })).toBeNull();
  });
  test("a long range keeps 12 lines and counts the rest", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: "+", number: i + 1, text: `l${i}` }));
    const d = makeDraft({ id: "1", path: "a", rows: many, from: 0, to: 19, body: "x" });
    expect(d.quote).toHaveLength(12);
    expect(d.cut).toBe(8);
  });
});

describe("locate / findRow", () => {
  const d = makeDraft({ id: "1", path: "a.js", rows, from: 3, to: 4, body: "x" });
  test("finds its lines again", () => {
    expect(locate(rows, d)).toEqual({ from: 3, to: 4 });
  });
  test("lines that moved (numbers shifted) are found by kind and text when that is unambiguous", () => {
    const moved = rows.map((r) => (r.number ? { ...r, number: r.number + 10 } : r));
    expect(locate(moved, d)).toEqual({ from: 3, to: 4 });
  });
  test("gone lines, or an ambiguous moved line, make a stale draft", () => {
    expect(locate(rows.slice(0, 3), d)).toBeNull();
    const dup = [{ kind: "+", number: 9, text: "added" }, { kind: "+", number: 12, text: "added" }];
    expect(findRow(dup, { kind: "+", number: 1, text: "added" })).toBe(-1);
  });
  test("with identical lines the nearest to the hint wins", () => {
    const dup = [{ kind: "+", number: 1, text: "x" }, { kind: " ", number: 2, text: "m" }, { kind: "+", number: 1, text: "x" }];
    expect(findRow(dup, { kind: "+", number: 1, text: "x" }, 2)).toBe(2);
  });
});

describe("lineLabel", () => {
  test("new numbers for added/context, old numbers for removed-only", () => {
    expect(lineLabel({ quote: [{ kind: "+", number: 12, text: "" }, { kind: "+", number: 15, text: "" }] })).toBe("12–15");
    expect(lineLabel({ quote: [{ kind: "+", number: 7, text: "" }] })).toBe("7");
    expect(lineLabel({ quote: [{ kind: "-", number: 11, text: "" }, { kind: "-", number: 13, text: "" }] })).toBe("old 11–13");
    expect(lineLabel({ quote: [{ kind: "-", number: 2, text: "" }, { kind: "+", number: 2, text: "" }] })).toBe("2");
  });
});

describe("reviewMessage", () => {
  const a = makeDraft({ id: "1", path: "b.js", rows, from: 3, to: 3, body: "rename" });
  const b = makeDraft({ id: "2", path: "a.js", rows, from: 2, to: 3, body: "why?" });
  test("sorted by file then line, lines quoted in a diff fence, comment text verbatim", () => {
    const m = reviewMessage({ root: "/r", on: null, scopeWords: "working tree vs HEAD", drafts: [a, b] });
    expect(m.indexOf("### a.js")).toBeLessThan(m.indexOf("### b.js"));
    expect(m).toContain("2 comments.");
    expect(m).toContain("```diff\n-old line\n+new line\n```\nwhy?");
    expect(m).toContain("### b.js, lines 2\n```diff\n+new line\n```\nrename");
  });
  test("one comment is singular, a remote machine is named, a cut quote says how many lines were left out", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: "+", number: i + 1, text: `l${i}` }));
    const c = makeDraft({ id: "3", path: "c", rows: many, from: 0, to: 19, body: "big" });
    const m = reviewMessage({ root: "/r", on: "vps", scopeWords: "s", drafts: [c] });
    expect(m).toContain("(on vps)");
    expect(m).toContain("1 comment.");
    expect(m).toContain("… 8 more lines");
  });
});

describe("askMessage", () => {
  test("names the file, the lines and the repo, and quotes them", () => {
    const m = askMessage({ root: "/r", on: null, path: "a.js", rows: rows.slice(2, 4) });
    expect(m).toContain("About a.js, lines 2, in /r:");
    expect(m).toContain("```diff\n-old line\n+new line\n```");
  });
});

describe("matchAgents", () => {
  const agent = (address, pane, space, extra = {}) => ({ address, pane, space, focused: false, seq: 1, ...extra });
  const panes = [{ pane: "p1", cwd: "/r/sub" }, { pane: "p2", cwd: "/elsewhere" }, { pane: "p3", cwd: "/" }, { pane: "p4", cwd: "/w" }];
  const spaces = [{ id: "s1", folder: "/other" }, { id: "s2", folder: "/r" }, { id: "s3", folder: "/x" }];
  test("an agent in the repo first, then one whose space is the repo, then the rest", () => {
    const list = matchAgents({ agents: [agent("t2", "p2", "s1"), agent("t3", "p3", "s2"), agent("t1", "p1", "s3")], panes, spaces, root: "/r", on: null });
    expect(list.map((x) => [x.agent.address, x.score])).toEqual([["t1", 3], ["t3", 2], ["t2", 0]]);
  });
  test("an agent in a folder above a worktree ranks above strangers; the filesystem root counts for nothing; ties go to focus, then the most recent", () => {
    const list = matchAgents({ agents: [agent("t1", "p4", "s1", { seq: 9 }), agent("t2", "p3", "s1", { seq: 1 }), agent("t3", "p2", "s1", { seq: 5, focused: true }), agent("t4", "p2", "s1", { seq: 7 })], panes, spaces, root: "/w/tree", on: null });
    expect(list.map((x) => [x.agent.address, x.score])).toEqual([["t1", 1], ["t3", 0], ["t4", 0], ["t2", 0]]);
  });
  test("this computer's agents for a local repo, a machine's for a remote one", () => {
    const agents = [agent("t1", "p1", "s2"), agent("vps/t9", "p1", "s2")];
    expect(matchAgents({ agents, panes, spaces, root: "/r", on: null }).map((x) => x.agent.address)).toEqual(["t1"]);
    expect(matchAgents({ agents, panes, spaces, root: "/r", on: "vps" }).map((x) => x.agent.address)).toEqual(["vps/t9"]);
  });
});
