import { describe, expect, test } from "bun:test";
import { parseDiff } from "../mods/git-remote/diff.js";

const diff = (...lines) => lines.join("\n") + "\n";

describe("parseDiff", () => {
  test("counts and numbers a normal hunk", () => {
    const [f] = parseDiff(diff(
      "diff --git a/x.js b/x.js", "index 1..2 100644", "--- a/x.js", "+++ b/x.js",
      "@@ -10,3 +10,3 @@", " keep", "-old", "+new", " tail"));
    expect(f).toMatchObject({ path: "x.js", add: 1, del: 1, binary: false });
    expect(f.rows.map((r) => [r.kind, r.number])).toEqual([["@", undefined], [" ", 10], ["-", 11], ["+", 11], [" ", 12]]);
  });
  test("a removed '-- x' line (shown '--- x') and an added '++ x' line are content, not headers", () => {
    const [f] = parseDiff(diff("diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,2 @@", "--- drop me", "+++ add me"));
    expect(f).toMatchObject({ add: 1, del: 1 });
    expect(f.rows.map((r) => r.text)).toEqual(["@@ -1,2 +1,2 @@", "-- drop me", "++ add me"]);
  });
  test("a rename with no content change has no rows; a binary file is flagged", () => {
    const files = parseDiff(diff(
      "diff --git a/a b/b", "similarity index 100%", "rename from a", "rename to b",
      "diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ"));
    expect(files.map((f) => [f.path, f.rows.length, f.binary])).toEqual([["b", 0, false], ["i.png", 0, true]]);
  });
  test("several files, and empty input", () => {
    expect(parseDiff(diff("diff --git a/1 b/1", "@@ -1 +1 @@", "-a", "+b", "diff --git a/2 b/2", "@@ -1 +1 @@", "-c", "+d")).map((f) => f.path)).toEqual(["1", "2"]);
    expect(parseDiff("")).toEqual([]);
  });
});
