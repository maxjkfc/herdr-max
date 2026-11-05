import { describe, expect, test } from "bun:test";
import { treeRows } from "../mods/git-graph/filetree.js";

const files = ["README.md", "mods/git-graph/commit.js", "mods/git-graph/main.js", "mods/git-remote/main.js", "mods/git-remote/icons/a.svg", "keys.json"]
  .map((path) => ({ path, add: 1, del: 0 }));
const outline = (rows) => rows.map((r) => `${"  ".repeat(r.depth)}${r.type === "dir" ? (r.open ? "v " : "> ") + r.name : r.name}`);

describe("treeRows", () => {
  test("folders first, then files, each sorted; file rows point back at their index", () => {
    const rows = treeRows(files, new Set());
    expect(outline(rows)).toEqual([
      "v mods", "  v git-graph", "    commit.js", "    main.js", "  v git-remote", "    v icons", "      a.svg", "    main.js", "keys.json", "README.md"]);
    expect(rows.filter((r) => r.type === "file").map((r) => files[r.idx].path.split("/").pop())).toContain("a.svg");
    expect(rows.find((r) => r.type === "dir" && r.name === "mods").count).toBe(4);
  });
  test("a collapsed folder hides its contents but keeps its count", () => {
    const rows = treeRows(files, new Set(["mods/git-remote"]));
    expect(outline(rows)).toContain("  > git-remote");
    expect(outline(rows).join("\n")).not.toContain("icons");
    expect(rows.find((r) => r.key === "d:mods/git-remote").count).toBe(2);
  });
  test("a folder holding only one folder is joined with it", () => {
    const rows = treeRows([{ path: "a/b/c/x.js" }, { path: "a/b/c/y.js" }], new Set());
    expect(rows[0]).toMatchObject({ type: "dir", name: "a/b/c", path: "a/b/c", count: 2 });
    expect(rows).toHaveLength(3);
  });
  test("a filter keeps matching paths only, opens their folders even if collapsed, and is case-insensitive", () => {
    const rows = treeRows(files, new Set(["mods", "mods/git-graph"]), "MAIN");
    expect(outline(rows)).toEqual(["v mods", "  v git-graph", "    main.js", "  v git-remote", "    main.js"]);
  });
  test("a filter matching nothing, and no files, give no rows", () => {
    expect(treeRows(files, new Set(), "zzz")).toEqual([]);
    expect(treeRows([], new Set())).toEqual([]);
  });
});
