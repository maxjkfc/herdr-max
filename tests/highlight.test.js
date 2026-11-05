import { describe, expect, test } from "bun:test";
import { languageOf, tokenize } from "../mods/git-remote/highlight.js";

const classes = (text, lang, state = null) => tokenize(text, lang, state).spans.filter((s) => s.cls).map((s) => `${s.cls}:${s.text}`);

describe("languageOf", () => {
  test("by extension and by well-known file name; unknown gets no colors", () => {
    expect(languageOf("mods/git-remote/viewer.js")).toBe("js");
    expect(languageOf("a/b.PY")).toBe("python");
    expect(languageOf("Dockerfile")).toBe("sh");
    expect(languageOf("README.md")).toBeNull();
    expect(languageOf(undefined)).toBeNull();
  });
});

describe("tokenize", () => {
  test("keywords, strings, numbers and functions; the row's text is kept whole", () => {
    const t = tokenize("const x = foo(\"a\", 42);", "js", null);
    expect(t.spans.map((s) => s.text).join("")).toBe("const x = foo(\"a\", 42);");
    expect(classes("const x = foo(\"a\", 42);", "js")).toEqual(expect.arrayContaining(["keyword:const", "function:foo", "string:\"a\"", "number:42"]));
  });
  test("a block comment carries into the next row until it closes", () => {
    const first = tokenize("/* open", "js", null);
    expect(first.state).not.toBeNull();
    const second = tokenize("still */ x", "js", first.state);
    expect(second.state).toBeNull();
    expect(second.spans[0]).toMatchObject({ cls: "comment", text: "still */" });
  });
  test("an unknown language is one plain span", () => {
    expect(tokenize("whatever", "nope", null).spans).toEqual([{ text: "whatever", cls: "" }]);
  });
  test("a very long line is cut into few spans and loses no text", () => {
    const line = "a ".repeat(2000), t = tokenize(line, "js", null);
    expect(t.spans.map((s) => s.text).join("")).toBe(line);
    expect(t.spans.length).toBeLessThanOrEqual(30);
  });
});
