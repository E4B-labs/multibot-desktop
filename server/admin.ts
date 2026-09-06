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
import { promisify } from "node:util";

import type { RuntimeEvent } from "./contracts.ts";
import { deviceResources } from "./device.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import type { AdminUser } from "./identity.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Enough to describe a busy day without ever being a memory question: at
 * ~40 bytes an entry the two rings together cost well under 100 KB. */
const RING = 500;
const MEMO_MS = 60_000;
const GPU_QUERY = ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"];

interface TurnSample {
  at: number;
  /** null when the turn began before this process did (restart mid-turn). */
  ms: number | null;
  ok: boolean;
}
interface TokenSample {
  at: number;
  n: number;
}

const turns: TurnSample[] = [];
const tokens: TokenSample[] = [];
const startedAt = new Map<string, number>();
let tally: { at: number; byUser: Map<string, number> } | null = null;
let gpuCache: { at: number; value: GpuInfo[] | null } | null = null;
let appVersion: string | null = null;

function push<T>(ring: T[], entry: T): void {
  ring.push(entry);
  if (ring.length > RING) ring.shift();
}

/** Entries are appended in clock order, so everything older than the window is
 * a prefix: one splice both answers the read and shrinks the ring. */
function within<T extends { at: number }>(ring: T[], now: number): T[] {
  const first = ring.findIndex((entry) => entry.at > now - DAY_MS);
  ring.splice(0, first === -1 ? ring.length : first);
  return ring;
}

/** Wire once, next to `workspace.recordTurn`: every runtime event passes here
 * and only four of them leave a trace. */
export function recordTurnEvent(event: RuntimeEvent, now = Date.now()): void {
  const key = event.turnId ?? event.threadId;
  if (event.type === "turn.started") {
    // A turn that never completes (killed process, closed session) would leak
    // an entry per thread; the ring bound applies here too.
    if (startedAt.size >= RING) startedAt.delete(startedAt.keys().next().value as string);
    startedAt.set(key, now);
    return;
  }
  if (event.type === "thread.token-usage.updated") {
    push(tokens, { at: now, n: Math.max(0, event.input) + Math.max(0, event.output) });
    return;
  }
  if (event.type !== "turn.completed" && event.type !== "runtime.error") return;
  const began = startedAt.get(key);
  startedAt.delete(key);
  push(turns, { at: now, ms: began === undefined ? null : now - began, ok: event.type === "turn.completed" && event.ok });
}

export function performanceSummary(now = Date.now()) {
  const window = within(turns, now);
  const done = window.filter((turn) => turn.ok);
  const errors = window.length - done.length;
  const times = done.map((turn) => turn.ms).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
  return {
    avgResponseMs: times.length ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length) : 0,
    // Nearest-rank p95: with a handful of samples the honest answer is the
    // slowest one, not an interpolation between two of them.
    p95ResponseMs: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] : 0,
    turns24h: done.length,
    tokens24h: within(tokens, now).reduce((sum, sample) => sum + sample.n, 0),
    errorRate: window.length ? errors / window.length : 0,
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
export async function gpuInfo(now = Date.now(), binary = "nvidia-smi"): Promise<GpuInfo[] | null> {
  if (gpuCache && now - gpuCache.at < MEMO_MS) return gpuCache.value;
  const value = await new Promise<GpuInfo[] | null>((resolve) => {
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
  gpuCache = { at: now, value };
  return value;
}

interface AdminBot {
  id: string;
  threadId: string;
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
  store: { bots: AdminBot[]; messagesFor(threadId: string): AdminMessage[] };
  server: { getConnections(callback: (error: Error | null, count: number) => void): unknown };
  now?: () => number;
  gpuBinary?: string;
}

function messageTally(store: AdminDeps["store"], now: number): Map<string, number> {
  if (tally && now - tally.at < MEMO_MS) return tally.byUser;
  const byUser = new Map<string, number>();
  // ponytail: full transcript scan, add a user_stats table when slow
  for (const bot of store.bots) {
    for (const message of store.messagesFor(bot.threadId)) {
      if (message.role !== "user" || !message.userId) continue;
      byUser.set(message.userId, (byUser.get(message.userId) ?? 0) + 1);
    }
  }
  tally = { at: now, byUser };
  return byUser;
}

function version(): string {
  if (appVersion === null) {
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: string };
      appVersion = pkg.version ?? "0.0.0";
    } catch {
      appVersion = "0.0.0";
    }
  }
  return appVersion;
}

async function connectionCount(server: AdminDeps["server"]): Promise<number> {
  try {
    return await promisify(server.getConnections.bind(server) as (cb: (error: Error | null, count: number) => void) => void)();
  } catch {
    return 0;
  }
}

export async function adminOverview(deps: AdminDeps) {
  const now = deps.now?.() ?? Date.now();
  const resources = deviceResources();
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
      connectionsActive: await connectionCount(deps.server),
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
 * that measures it has to start from empty. */
export function resetAdminMetricsForTests(): void {
  turns.length = 0;
  tokens.length = 0;
  startedAt.clear();
  tally = null;
  gpuCache = null;
}
