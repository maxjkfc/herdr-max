import { describe, expect, test } from "bun:test";
import { counts } from "../mods/agents-plus/logic.js";
import { mostUrgent } from "../mods/tmux-prefix/urgent.js";

const ag = (address, status, seq) => ({ address, status, seq });

describe("mostUrgent", () => {
  test("blocked beats a more recent done", () => {
    expect(mostUrgent([ag("a", "done", 9), ag("b", "blocked", 1)]).address).toBe("b");
  });
  test("among equals the most recent wins", () => {
    expect(mostUrgent([ag("a", "done", 2), ag("b", "done", 5), ag("c", "done", 3)]).address).toBe("b");
  });
  test("working and idle agents never count", () => {
    expect(mostUrgent([ag("a", "working", 9), ag("b", "idle", 8)])).toBeNull();
    expect(mostUrgent([])).toBeNull();
  });
});

test("counts tallies each state and ignores unknown ones", () => {
  expect(counts([ag("a", "blocked"), ag("b", "done"), ag("c", "done"), ag("d", "working"), ag("e", "weird")])).toEqual({
    blocked: 1,
    done: 2,
    working: 1,
    idle: 0,
  });
});
