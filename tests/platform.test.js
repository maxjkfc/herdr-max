import { describe, expect, test } from "bun:test";
import { describeRemote, githubSlug } from "../mods/git-remote/platform.js";

describe("describeRemote", () => {
  const id = (u) => describeRemote(u)?.id;
  test("recognises the platform from the host, whatever the URL form", () => {
    expect(id("git@github.com:maxjkfc/herdr-max.git")).toBe("github");
    expect(id("https://github.com/a/b")).toBe("github");
    expect(id("ssh://git@gitlab.example.com:2222/g/p.git")).toBe("gitlab");
    expect(id("git@bitbucket.org:t/r.git")).toBe("bitbucket");
    expect(id("https://dev.azure.com/o/p/_git/r")).toBe("azure");
    expect(id("https://git.sr.ht/~u/r")).toBe("sourcehut");
    expect(id("git@github.mycorp.com:a/b.git")).toBe("ghe");
  });
  test("a nested GitLab group keeps its whole path", () => {
    expect(describeRemote("https://gitlab.com/g/sub/proj.git").slug).toBe("g/sub/proj");
  });
  test("an unlisted host is reported as itself", () => {
    expect(describeRemote("https://example.org/x/y.git")).toMatchObject({ id: "git", label: "example.org", slug: "x/y" });
  });
  test("things that are not remotes give null", () => {
    expect(describeRemote("/local/path")).toBeNull();
    expect(describeRemote("file:///x/y")).toBeNull();
    expect(describeRemote("")).toBeNull();
    expect(describeRemote(undefined)).toBeNull();
  });
});

describe("githubSlug", () => {
  test("only a github.com owner/repo is a slug", () => {
    expect(githubSlug(describeRemote("git@github.com:a/b.git"))).toBe("a/b");
    expect(githubSlug(describeRemote("https://github.com/a/b/extra"))).toBeNull();
    expect(githubSlug(describeRemote("https://gitlab.com/a/b"))).toBeNull();
    expect(githubSlug(describeRemote("git@github.mycorp.com:a/b.git"))).toBeNull();
    expect(githubSlug(null)).toBeNull();
  });
});
