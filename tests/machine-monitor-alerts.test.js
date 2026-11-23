import { expect, test } from "bun:test";
import { step } from "../mods/machine-monitor/alerts.js";

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
