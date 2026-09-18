import { beforeEach, describe, expect, it } from "vitest";
import {
  collectStartup,
  formatStartupReport,
  getStartupReport,
  markStartup,
  onStartupReady,
  resetStartupTiming,
  type PerfLike,
} from "./startupTiming";

function fakePerf(now: number[], resources: any[] = [], nav: any = null): PerfLike & { marked: string[] } {
  let i = 0;
  const marked: string[] = [];
  return {
    marked,
    now: () => now[Math.min(i++, now.length - 1)],
    mark: (name) => void marked.push(name),
    getEntriesByType: (type) => (type === "navigation" ? (nav ? [nav] : []) : resources),
  };
}

const NAV = { responseEnd: 120, requestStart: 20, transferSize: 0, deliveryType: "cache" };
const RESOURCES = [
  { name: "https://h/assets/index-abc.js", initiatorType: "script", responseEnd: 400, duration: 250, startTime: 150 },
  { name: "https://h/api/bots", initiatorType: "fetch", startTime: 700, responseEnd: 1300, duration: 600 },
  { name: "https://h/api/config?x=1", initiatorType: "fetch", startTime: 710, responseEnd: 900, duration: 190 },
  { name: "https://h/api/late", initiatorType: "fetch", startTime: 5000, responseEnd: 5100, duration: 100 },
];

describe("startupTiming", () => {
  beforeEach(resetStartupTiming);

  it("collects html, bundle, api calls before ready and marks in time order", () => {
    const marks = new Map([["js-start", 450], ["events-open", 1000], ["bots-rendered", 1400], ["ready", 1400]]);
    const r = collectStartup(fakePerf([9999], RESOURCES, NAV), marks);
    expect(r.steps.map((s) => s.name)).toEqual([
      "html", "bundle index-abc.js", "js-start", "api-first", "api /api/config", "events-open", "api /api/bots", "bots-rendered", "ready",
    ]);
    expect(r.steps.find((s) => s.name === "api /api/bots")).toEqual({ name: "api /api/bots", ms: 1300, durMs: 600 });
    expect(r.totalMs).toBe(1400);
    expect(r.fromCache).toBe(true);
    // /api/late started after ready: not a boot step
    expect(r.steps.some((s) => s.name.includes("late"))).toBe(false);
  });

  it("first mark wins and ready fires once both gates passed", () => {
    const p = fakePerf([10, 200, 900, 1500, 1600, 5000], RESOURCES);
    const seen: number[] = [];
    onStartupReady((r) => seen.push(r.totalMs));
    markStartup("js-start", p);
    markStartup("js-start", p); // ignored
    markStartup("events-open", p);
    expect(getStartupReport()).toBeNull();
    markStartup("bots-rendered", p);
    expect(seen).toEqual([1500]);
    expect(p.marked).toEqual(["mb:js-start", "mb:events-open", "mb:bots-rendered", "mb:ready"]);
    // late listener gets the cached report, reconnect does not reset it
    markStartup("events-open", p);
    onStartupReady((r) => seen.push(r.totalMs));
    expect(seen).toEqual([1500, 1500]);
  });

  it("survives a performance object without mark or resource timing", () => {
    const p: PerfLike = { now: () => 42 };
    markStartup("events-open", p);
    markStartup("bots-rendered", p);
    const r = getStartupReport()!;
    expect(r.totalMs).toBe(42);
    expect(r.steps.map((s) => s.name)).toEqual(["events-open", "bots-rendered", "ready"]);
    expect(formatStartupReport(r)).toContain("42 ms  ready");
  });
});
