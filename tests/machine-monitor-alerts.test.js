import { expect, test } from "bun:test";
import { DEFAULTS, limitsOf, step } from "../mods/machine-monitor/alerts.js";

const DAY = 86400;
const stats = (over = {}) => ({ diskPct: 50, diskFreeGb: 100, diskTotalGb: 200, upSec: 3 * DAY, ...over });

test("nothing to say while disk and uptime are under their lines", () => {
  expect(step("ody", stats({ diskPct: 91, upSec: 27 * DAY }), null).alerts).toEqual([]);
});

test("disk at 92% notifies once, stays quiet while high, and re-arms only below 90%", () => {
  let r = step("macmini", stats({ diskPct: 92 }), null);
  expect(r.alerts.map((a) => a.title)).toEqual(["macmini 磁碟用量 92%"]);
  r = step("macmini", stats({ diskPct: 95 }), r.state);
  expect(r.alerts).toEqual([]);
  r = step("macmini", stats({ diskPct: 91 }), r.state); // under the line but not under the re-arm gap
  expect(r.alerts).toEqual([]);
  r = step("macmini", stats({ diskPct: 92 }), r.state);
  expect(r.alerts).toEqual([]);
  r = step("macmini", stats({ diskPct: 89 }), r.state);
  r = step("macmini", stats({ diskPct: 93 }), r.state);
  expect(r.alerts.length).toBe(1);
});

test("28 days of uptime notifies once and re-arms after a reboot", () => {
  let r = step("ody", stats({ upSec: 28 * DAY }), null);
  expect(r.alerts.map((a) => a.title)).toEqual(["ody 已連續運作 28 天"]);
  r = step("ody", stats({ upSec: 29 * DAY }), r.state);
  expect(r.alerts).toEqual([]);
  r = step("ody", stats({ upSec: 60 }), r.state); // rebooted
  r = step("ody", stats({ upSec: 28 * DAY }), r.state);
  expect(r.alerts.length).toBe(1);
});

test("both conditions at once give two notifications; state remembers both", () => {
  const r = step("x", stats({ diskPct: 99, upSec: 40 * DAY }), null);
  expect(r.alerts.length).toBe(2);
  expect(r.state).toEqual({ disk: true, uptime: true });
  expect(step("x", stats({ diskPct: 99, upSec: 40 * DAY }), r.state).alerts).toEqual([]);
});

test("custom limits move both lines; the SSD re-arm gap follows the limit", () => {
  const limits = { diskPct: 80, uptimeDays: 7 };
  let r = step("a", stats({ diskPct: 80, upSec: 7 * DAY }), null, limits);
  expect(r.alerts.length).toBe(2);
  r = step("a", stats({ diskPct: 79, upSec: 8 * DAY }), r.state, limits); // 79 is not under 80 - 2
  r = step("a", stats({ diskPct: 80, upSec: 8 * DAY }), r.state, limits);
  expect(r.alerts).toEqual([]);
  r = step("a", stats({ diskPct: 77, upSec: 8 * DAY }), r.state, limits);
  r = step("a", stats({ diskPct: 80, upSec: 8 * DAY }), r.state, limits);
  expect(r.alerts.map((a) => a.title)).toEqual(["a 磁碟用量 80%"]);
  expect(step("a", stats({ upSec: 7 * DAY - 1 }), null, limits).alerts).toEqual([]);
  expect(step("a", stats({ diskPct: 91, upSec: 27 * DAY }), null).alerts).toEqual([]); // default 92 / 28
});

test("saved limits are whole numbers inside their ranges, with defaults for anything off", () => {
  expect(limitsOf(undefined)).toEqual(DEFAULTS);
  expect(limitsOf({ diskPct: 85.6, uptimeDays: "14" })).toEqual({ diskPct: 86, uptimeDays: 14, pollSec: 30 });
  expect(limitsOf({ diskPct: 10, uptimeDays: 9999 })).toEqual({ diskPct: 50, uptimeDays: 365, pollSec: 30 });
  expect(limitsOf({ diskPct: "x", uptimeDays: null })).toEqual(DEFAULTS);
  expect(limitsOf({ pollSec: 1 }).pollSec).toBe(10);
  expect(limitsOf({ pollSec: 5000 }).pollSec).toBe(600);
});
