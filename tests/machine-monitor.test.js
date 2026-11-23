import { expect, test } from "bun:test";
import { DETAIL_PROBE, PROBE, fmtUptime, parseDetail, parseProbe, watchedList } from "../mods/machine-monitor/probe.js";

const linux = `os=Linux
up=1795213
cores=4
load=0.50 0.40 0.30
memtotal=8388608
memavail=2097152
disktotal=104857600
diskavail=26214400
`;

test("parses a probe answer into readout numbers", () => {
  const s = parseProbe(linux);
  expect(s.upSec).toBe(1795213);
  expect(s.load).toEqual([0.5, 0.4, 0.3]);
  expect(s.loadPerCore).toBeCloseTo(0.125);
  expect(s.memPct).toBe(75);
  expect(s.memTotalGb).toBe(8);
  expect(s.diskPct).toBe(75);
  expect(s.diskFreeGb).toBe(25);
});

test("an incomplete or unsupported answer is null, not zeros", () => {
  expect(parseProbe("os=FreeBSD\nerror=unsupported FreeBSD\n")).toBeNull();
  expect(parseProbe(linux.replace(/^memavail=.*\n/m, ""))).toBeNull();
  expect(parseProbe(linux.replace("load=0.50 0.40 0.30", "load=0.50"))).toBeNull();
  expect(parseProbe("")).toBeNull();
});

test("the real probe answers on this machine", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const out = await Bun.$`sh -c ${PROBE}`.text();
  const s = parseProbe(out);
  expect(s).not.toBeNull();
  // Uptime from the boot time must be a plausible span, not "since 1970" (a sed that matched usec once gave 56 years).
  expect(s.upSec).toBeGreaterThan(0);
  expect(s.upSec).toBeLessThan(10 * 365 * 86400);
  expect(s.memPct).toBeGreaterThanOrEqual(0);
  expect(s.memPct).toBeLessThanOrEqual(100);
});

test("uptime shows the two biggest units", () => {
  expect(fmtUptime(4 * 86400 + 21 * 3600 + 7 * 60)).toBe("4d 21h");
  expect(fmtUptime(3 * 3600 + 12 * 60)).toBe("3h 12m");
  expect(fmtUptime(300)).toBe("5m");
  expect(fmtUptime(-5)).toBe("0m");
});

test("watched list is null until saved, and drops junk entries", () => {
  expect(watchedList(undefined)).toBeNull();
  expect(watchedList(["ody", "", 3, "macmini"])).toEqual(["ody", "macmini"]);
  expect(watchedList([])).toEqual([]);
});

test("detail answer keeps the kernel, host and process names that contain spaces or pipes", () => {
  const d = parseDetail(`host=box
kernel=6.1.0
topcpu=36.4|0.1|Open Design Hel
topcpu=not-a-number|1|junk
topmem=2.5|16.7|odd|name
`);
  expect(d.host).toBe("box");
  expect(d.kernel).toBe("6.1.0");
  expect(d.topCpu).toEqual([{ cpu: 36.4, mem: 0.1, name: "Open Design Hel" }]);
  expect(d.topMem).toEqual([{ cpu: 2.5, mem: 16.7, name: "odd|name" }]);
});

test("the real detail probe adds host and process lists to the readout", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const out = await Bun.$`sh -c ${DETAIL_PROBE}`.text();
  expect(parseProbe(out)).not.toBeNull();
  const d = parseDetail(out);
  expect(d.host).not.toBe("");
  expect(d.topCpu.length).toBeGreaterThan(0);
  expect(d.topCpu.length).toBeLessThanOrEqual(5);
});
