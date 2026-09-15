// Memory-aware spawning.
//
// Measured on the production phone (Termux, 5.4 GB): `os.freemem()` reports
// MemFree (117 MB) while /proc/meminfo MemAvailable says 2.4 GB — Android keeps
// almost everything in page cache. Spawning on freemem alone would stall for
// ever; spawning blind is how Android's LMK kills Termux. So read MemAvailable
// where it exists and fall back to freemem elsewhere.
import { readFileSync } from "node:fs";
import os from "node:os";

/** Parse a /proc/meminfo body; null when the key is absent. */
export function parseMeminfo(text: string, key: "MemAvailable" | "MemTotal"): number | null {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
  return m ? Number(m[1]) * 1024 : null;
}

const meminfo = (key: "MemAvailable" | "MemTotal"): number | null => {
  if (process.platform !== "linux" && process.platform !== "android") return null;
  try {
    return parseMeminfo(readFileSync("/proc/meminfo", "utf8"), key);
  } catch {
    return null;
  }
};

export const availableMemoryBytes = (): number => meminfo("MemAvailable") ?? os.freemem();
export const totalMemoryBytes = (): number => meminfo("MemTotal") ?? os.totalmem();

export const memFloorBytes = (): number => (Number(process.env.MULTIBOT_MEM_FLOOR_MB) || 300) * 1024 * 1024;
const memWaitMs = (): number => Number(process.env.MULTIBOT_MEM_WAIT_MS) || 15_000;

export interface MemoryGuardDeps {
  available?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A brake, not a gate: when spawning `estimateBytes` would push available
 * memory under the floor, wait (1 s steps, up to MULTIBOT_MEM_WAIT_MS) for
 * something else to finish — then proceed anyway. Nothing is ever refused or
 * queued: the user wants unlimited parallel bots; this only gives Android a
 * moment before LMK reaches for Termux.
 *
 * Returns how long it waited (ms), for tests and logs.
 */
export async function memoryGuard(estimateBytes: number, deps: MemoryGuardDeps = {}): Promise<number> {
  const available = deps.available ?? availableMemoryBytes;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const need = memFloorBytes() + estimateBytes;
  const limit = memWaitMs();
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  let have = available();
  if (have >= need) return 0;
  console.warn(`[multibot] low memory: ${mb(have)} MB available, want ${mb(need)} MB — waiting up to ${Math.round(limit / 1000)} s`);
  let waited = 0;
  while (waited < limit) {
    await sleep(1000);
    waited += 1000;
    have = available();
    if (have >= need) return waited;
  }
  console.warn(`[multibot] still ${mb(have)} MB available after ${Math.round(waited / 1000)} s — spawning anyway`);
  return waited;
}
