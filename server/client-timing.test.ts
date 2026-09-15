import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendClientTiming, parseClientTiming, readClientTiming } from "./client-timing.ts";

const dirs: string[] = [];
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-client-timing-"));
  dirs.push(dir);
  return join(dir, "nested", "client-timing.jsonl");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = (totalMs: number) => ({
  origin: "https://127.0.0.1:8799",
  userAgent: "WebView",
  steps: [{ name: "js-start", ms: 100.4 }, { name: "api /api/bots", ms: 900, durMs: 300.6 }],
  totalMs,
  at: "2026-09-15T10:00:00.000Z",
  fromCache: true,
});

describe("parseClientTiming", () => {
  it("rejects garbage and keeps only well-formed steps", () => {
    expect(parseClientTiming(null)).toBeNull();
    expect(parseClientTiming({ steps: "x", totalMs: 1 })).toBeNull();
    expect(parseClientTiming({ steps: [], totalMs: -5 })).toBeNull();
    const parsed = parseClientTiming({ ...entry(1500.6), steps: [...entry(0).steps, { ms: 5 }, { name: "x", ms: "nope" }] })!;
    expect(parsed.totalMs).toBe(1501);
    expect(parsed.steps).toEqual([{ name: "js-start", ms: 100 }, { name: "api /api/bots", ms: 900, durMs: 301 }]);
    expect(parsed.fromCache).toBe(true);
    expect(parseClientTiming({ steps: [], totalMs: 1, at: "not a date" })!.at).toMatch(/^\d{4}-/);
  });
});

describe("appendClientTiming / readClientTiming", () => {
  it("appends one JSON line per boot and reads newest first", () => {
    const file = tempFile();
    appendClientTiming(file, parseClientTiming(entry(1000))!);
    appendClientTiming(file, parseClientTiming(entry(2000))!);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(readClientTiming(file, 20).map((e) => e.totalMs)).toEqual([2000, 1000]);
    expect(readClientTiming(file, 1).map((e) => e.totalMs)).toEqual([2000]);
    expect(readClientTiming(join(dirs[0], "missing.jsonl"))).toEqual([]);
  });

  it("drops the oldest lines past the cap", () => {
    const file = tempFile();
    for (let i = 1; i <= 7; i++) appendClientTiming(file, parseClientTiming(entry(i))!, 5);
    expect(readClientTiming(file, 100).map((e) => e.totalMs)).toEqual([7, 6, 5, 4, 3]);
  });
});
