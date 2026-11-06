import { expect, test } from "bun:test";
import { step } from "../mods/status-quota/alerts.js";

const MIN = 60_000;
const prov = (remaining, used, resetsAt = 10_000 * MIN) => [
  { id: "claude", name: "Claude", items: [{ label: "5h", remaining, used, resetsAt, resetText: "1h" }] },
];

test("alerts once per level per window, escalates, and re-arms after the window resets", () => {
  let r = step(prov(50, 50), null, 0);
  expect(r.alerts).toEqual([]);
  r = step(prov(15, 85), r.state, MIN);
  expect(r.alerts.map((a) => a.level)).toEqual([1]);
  r = step(prov(12, 88), r.state, 2 * MIN);
  expect(r.alerts).toEqual([]); // still low: no repeat
  r = step(prov(4, 96), r.state, 3 * MIN);
  expect(r.alerts.map((a) => a.level)).toEqual([2]); // escalation
  r = step(prov(100, 0, 20_000 * MIN), r.state, 4 * MIN); // new window
  expect(r.alerts).toEqual([]);
  r = step(prov(10, 90, 20_000 * MIN), r.state, 5 * MIN);
  expect(r.alerts.map((a) => a.level)).toEqual([1]); // fires again in the new window
});

test("a few seconds of resetsAt drift is not a new window", () => {
  let r = step(prov(10, 90, 10_000 * MIN), null, 0);
  expect(r.alerts).toHaveLength(1);
  r = step(prov(9, 91, 10_000 * MIN + 3000), r.state, MIN);
  expect(r.alerts).toEqual([]);
});

test("estimates the time to run out only when that is before the reset", () => {
  // 10% used per 30 min, 40% left -> ~2h left, reset is 5h away
  let r = step(prov(60, 40, 300 * MIN), null, 0);
  expect(r.eta).toEqual({});
  r = step(prov(50, 50, 300 * MIN), r.state, 30 * MIN);
  expect(Math.round(r.eta["claude|5h"].ms / MIN)).toBe(150);
  // same rate but the reset comes first -> no warning
  r = step(prov(60, 40, 100 * MIN), null, 0);
  r = step(prov(50, 50, 100 * MIN), r.state, 30 * MIN);
  expect(r.eta).toEqual({});
});

test("no estimate from a short span or flat usage", () => {
  let r = step(prov(60, 40, 300 * MIN), null, 0);
  r = step(prov(50, 50, 300 * MIN), r.state, 2 * MIN);
  expect(r.eta).toEqual({});
  r = step(prov(50, 50, 300 * MIN), r.state, 60 * MIN);
  expect(r.eta).toEqual({});
});
