// What the owner sees in the admin tab: who is on this server, what it runs
// on, how the fleet has behaved in the last day, and what was done to accounts.
//
// Everything here is derived on read from data the server already keeps — no
// new tables, no background collector. The one thing that has to be observed
// live is turn timing, so the runtime bus drops events into a ring buffer.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeEvent } from "./contracts.ts";
import { deviceResources } from "./device.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import type { AdminUser } from "./identity.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** On a fleet that runs more turns than this in a day the cap, not the clock,
 * becomes the real window — so it is sized to make that unlikely rather than
 * tidy: at ~40 bytes an entry the ring stays a quarter of a megabyte.
 * ponytail: in-memory ring; persist or sample if a fleet ever outruns it. */
const RING = 5_000;
/** The tab polls every 10 s, so anything costlier than a property access is
 * computed once a minute and served from a cache in between. */
const MEMO_MS = 60_000;
const GPU_QUERY = ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"];

interface TurnSample {
  at: number;
  /** null when the turn began before this process did (restart mid-turn). */
  ms: number | null;
  ok: boolean;
}

const turns: TurnSample[] = [];
const startedAt = new Map<string, number>();
let tally: { at: number; byUser: Map<string, number> } | null = null;
let machine: { at: number; value: ReturnType<typeof deviceResources> } | null = null;
/** The promise, not the result: a second caller during the 1 s probe waits on
 * the first one instead of spawning nvidia-smi again. */
let gpuCache: { at: number; binary: string; value: Promise<GpuInfo[] | null> } | null = null;
let appVersion: string | null = null;

/** Entries are appended in clock order, so everything older than the window is
 * a prefix: one splice both answers the read and shrinks the ring. */
function within(ring: TurnSample[], now: number): TurnSample[] {
  const first = ring.findIndex((entry) => entry.at > now - DAY_MS);
  ring.splice(0, first === -1 ? ring.length : first);
  return ring;
}

/** Wire once, next to `workspace.recordTurn`: every runtime event passes here
 * and only two of them leave a trace.
 *
 * `runtime.error` is deliberately NOT one of them. Drivers emit it mid-turn for
 * every tool a bot's permissions refuse (`drivers/codex.ts`, `drivers/acp`) and
 * the turn carries on regardless; the fatal ones (spawn failure, CLI exit before
 * a result) are always followed by `settle(false, …)`, which is a
 * `turn.completed` with `ok:false`. So the completed event alone is both
 * complete and correct, and counting errors too would score a denied `rm` as a
 * failed turn. */
export function recordTurnEvent(event: RuntimeEvent, now = Date.now()): void {
  const key = event.turnId ?? event.threadId;
  if (event.type === "turn.started") {
    // A turn that never completes (killed process, closed session) would leak
    // an entry per thread; the ring bound applies here too.
    if (startedAt.size >= RING) startedAt.delete(startedAt.keys().next().value as string);
    startedAt.set(key, now);
    return;
  }
  if (event.type !== "turn.completed") return;
  const began = startedAt.get(key);
  startedAt.delete(key);
  turns.push({ at: now, ms: began === undefined ? null : now - began, ok: event.ok });
  if (turns.length > RING) turns.shift();
}

export function performanceSummary(now = Date.now()) {
  const window = within(turns, now);
  const done = window.filter((turn) => turn.ok);
  // Only a turn that produced an answer has a response time; how long a failure
  // took before giving up would drag the average around for no reader's benefit.
  const times = done.map((turn) => turn.ms).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
  return {
    avgResponseMs: times.length ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length) : 0,
    // Nearest-rank p95: with a handful of samples the honest answer is one of
    // them, not an interpolation between two.
    p95ResponseMs: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] : 0,
    // Every turn, so the card's own two numbers reconcile: turns24h × errorRate
    // is the number of failures.
    //
    // No tokens24h: `workspace` keeps lifetime totals per bot, and a second ring
    // for the 24 h figure would be a whole mechanism for one decorative number.
    // The plan allows dropping it; add it back with the usage table it needs.
    turns24h: window.length,
    errorRate: window.length ? (window.length - done.length) / window.length : 0,
  };
}

export interface GpuInfo {
  name: string;
  utilization: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
}

function parseGpuRow(line: string): GpuInfo | null {
  const [name, utilization, used, total] = line.split(",").map((cell) => cell.trim());
  if (!name || [utilization, used, total].some((cell) => !cell || !Number.isFinite(Number(cell)))) return null;
  return { name, utilization: Number(utilization), memoryUsedMb: Number(used), memoryTotalMb: Number(total) };
}

/** `null` on every machine without an NVIDIA driver, which is most of them —
 * AMD and Apple ship no equivalent query tool, and guessing from /sys would be
 * a per-vendor parser for a decoration.
 * ponytail: nvidia-smi only; add a vendor probe when someone asks for one. */
export function gpuInfo(now = Date.now(), binary = "nvidia-smi"): Promise<GpuInfo[] | null> {
  if (gpuCache && gpuCache.binary === binary && now - gpuCache.at < MEMO_MS) return gpuCache.value;
  const value = new Promise<GpuInfo[] | null>((resolve) => {
    let cli: ReturnType<typeof resolveCliSpawn>;
    try {
      cli = resolveCliSpawn(binary, GPU_QUERY);
    } catch {
      return resolve(null);
    }
    execFile(
      cli.command,
      cli.args,
      { timeout: 1_000, windowsVerbatimArguments: cli.windowsVerbatimArguments, env: { ...process.env, PATH: augmentedPath() } },
      (error, stdout) => {
        if (error) return resolve(null);
        const rows = String(stdout).trim().split(/\r?\n/).map(parseGpuRow).filter((row): row is GpuInfo => row !== null);
        resolve(rows.length ? rows : null);
      },
    );
  });
  gpuCache = { at: now, binary, value };
  return value;
}

interface AdminBot {
  busy?: boolean;
  visibility?: string;
  ownerId?: string;
}
interface AdminMessage {
  role: string;
  userId?: string;
}
export interface AdminDeps {
  identity: {
    usersWithActivity(): AdminUser[];
    recentAudit(limit: number): Array<{ at: number; action: string; userId: string | null; target: string | null }>;
    /** Optional so this module keeps building against an identity store that
     * predates the address discovery of PR 3. */
    getMeta?(key: string): string | null;
  };
  store: { bots: AdminBot[]; residentTranscripts(): AdminMessage[][] };
  server: { getConnections(callback: (error: Error | null, count: number) => void): unknown };
  /** SHA-256 of the self-signed certificate this harness serves. The admin tab
   * shows it so a "server certificate changed" refusal can be checked by eye. */
  tlsFingerprint?: string | null;
  now?: () => number;
  gpuBinary?: string;
}

/** Counted from the transcripts already in memory.
 * ponytail: threads nobody has opened since the last restart count 0, so this
 * is a floor, not a total. Reading them all would cold-load and REWRITE every
 * transcript file on a GET; add a user_stats table when the number must be exact. */
function messageTally(store: AdminDeps["store"], now: number): Map<string, number> {
  if (tally && now - tally.at < MEMO_MS) return tally.byUser;
  const byUser = new Map<string, number>();
  for (const transcript of store.residentTranscripts()) {
    for (const message of transcript) {
      if (message.role !== "user" || !message.userId) continue;
      byUser.set(message.userId, (byUser.get(message.userId) ?? 0) + 1);
    }
  }
  tally = { at: now, byUser };
  return byUser;
}

/** Packaged, electron-builder copies `dist-server` to `Resources/server` and
 * leaves package.json in the asar, so the relative path finds nothing — Electron
 * passes the version it already knows instead (`electron/main.mjs`). */
function version(): string {
  if (appVersion !== null) return appVersion;
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    appVersion = (JSON.parse(readFileSync(path, "utf8") as string) as { version?: string }).version ?? null;
  } catch { /* not this layout */ }
  return (appVersion ??= process.env.MULTIBOT_VERSION || "0.0.0");
}

export async function adminOverview(deps: AdminDeps) {
  const now = deps.now?.() ?? Date.now();
  if (!machine || now - machine.at >= MEMO_MS) machine = { at: now, value: deviceResources() };
  const resources = machine.value;
  const bots = deps.store.bots;
  const messages = messageTally(deps.store, now);
  const users = deps.identity.usersWithActivity().map((user) => ({
    ...user,
    messages: messages.get(user.id) ?? 0,
    botsOwned: bots.filter((bot) => bot.ownerId === user.id).length,
  }));
  const names = new Map(users.map((user) => [user.id, user.name]));
  const visible = (kind: string) => bots.filter((bot) => (bot.visibility ?? "team") === kind).length;
  return {
    users,
    server: {
      cpuLoad: resources.cpu.load,
      cpuCount: resources.cpu.count,
      ram: { usedBytes: resources.ram.totalBytes - resources.ram.freeBytes, totalBytes: resources.ram.totalBytes },
      disk: resources.disk,
      temperatures: resources.temperatures,
      gpu: await gpuInfo(now, deps.gpuBinary),
      uptimeMs: Math.round(process.uptime() * 1000),
      version: version(),
      publicAddress: deps.identity.getMeta?.("server.publicAddress") ?? null,
      addressVerified: Boolean(deps.identity.getMeta?.("server.addressVerifiedAt")),
      tlsFingerprint: deps.tlsFingerprint ?? null,
      connectionsActive: await new Promise<number>((resolve) => deps.server.getConnections((error, count) => resolve(error ? 0 : count))),
    },
    bots: {
      total: bots.length,
      busy: bots.filter((bot) => bot.busy).length,
      // Legacy bots carry no visibility and have always behaved as team-visible.
      byVisibility: { public: visible("public"), team: visible("team"), private: visible("private") },
    },
    performance: performanceSummary(now),
    audit: deps.identity.recentAudit(50).map((row) => ({ ...row, userName: (row.userId && names.get(row.userId)) || null })),
  };
}

/** Module state is process-wide on purpose (one server, one fleet); a suite
 * that measures the ring or the caches has to start from empty. */
export function resetAdminMetricsForTests(): void {
  turns.length = 0;
  startedAt.clear();
  tally = null;
  machine = null;
  gpuCache = null;
}
