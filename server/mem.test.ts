import { afterEach, describe, expect, it } from "vitest";

import { memoryGuard, parseMeminfo } from "./mem.ts";

const MEMINFO = `MemTotal:        5555556 kB
MemFree:          120000 kB
MemAvailable:    2457600 kB
Buffers:           12345 kB
`;

describe("mem", () => {
  afterEach(() => {
    delete process.env.MULTIBOT_MEM_FLOOR_MB;
    delete process.env.MULTIBOT_MEM_WAIT_MS;
  });

  // Android: MemFree says 117 MB while MemAvailable says 2.4 GB — the guard
  // must read the latter, or it would wait on every spawn.
  it("parses MemAvailable and MemTotal from /proc/meminfo, in bytes", () => {
    expect(parseMeminfo(MEMINFO, "MemAvailable")).toBe(2457600 * 1024);
    expect(parseMeminfo(MEMINFO, "MemTotal")).toBe(5555556 * 1024);
    expect(parseMeminfo("MemFree: 1 kB\n", "MemAvailable")).toBeNull();
  });

  it("does not wait when memory is plentiful", async () => {
    const waited = await memoryGuard(250 * 1024 * 1024, { available: () => 2 * 1024 ** 3, sleep: async () => {} });
    expect(waited).toBe(0);
  });

  it("waits for memory to free, then proceeds", async () => {
    process.env.MULTIBOT_MEM_FLOOR_MB = "300";
    let polls = 0;
    const mb = 1024 * 1024;
    const waited = await memoryGuard(250 * mb, { available: () => (++polls > 2 ? 600 * mb : 100 * mb), sleep: async () => {} });
    expect(waited).toBe(2000);
  });

  it("gives up waiting after MULTIBOT_MEM_WAIT_MS and still proceeds — a brake, not a gate", async () => {
    process.env.MULTIBOT_MEM_WAIT_MS = "3000";
    const waited = await memoryGuard(250 * 1024 * 1024, { available: () => 0, sleep: async () => {} });
    expect(waited).toBe(3000);
  });
});
