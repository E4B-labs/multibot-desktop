import { beforeEach, describe, expect, it } from "vitest";

import { adminOverview, gpuInfo, performanceSummary, recordTurnEvent, resetAdminMetricsForTests } from "./admin.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { AdminUser } from "./identity.ts";

const T0 = 1_800_000_000_000;
const base = { eventId: "e", provider: "claude" as const, threadId: "t1", createdAt: "" };
const started = (turnId: string): RuntimeEvent => ({ ...base, turnId, type: "turn.started" });
const completed = (turnId: string, ok = true): RuntimeEvent => ({ ...base, turnId, type: "turn.completed", ok });
const failed = (turnId: string): RuntimeEvent => ({ ...base, turnId, type: "runtime.error", message: "boom" });
const tokens = (input: number, output: number): RuntimeEvent => ({ ...base, type: "thread.token-usage.updated", input, output });

/** One turn, start to finish, `ms` long, finishing at `at`. */
function turn(turnId: string, at: number, ms: number, ok = true): void {
  recordTurnEvent(started(turnId), at - ms);
  recordTurnEvent(completed(turnId, ok), at);
}

beforeEach(() => resetAdminMetricsForTests());

describe("turn ring", () => {
  it("averages and ranks only the turns inside the 24 h window", () => {
    turn("old", T0 - 25 * 60 * 60 * 1000, 9_000);
    for (let i = 0; i < 19; i++) turn(`fast-${i}`, T0 - 60_000 - i, 100);
    turn("slow", T0 - 30_000, 2_000);

    const summary = performanceSummary(T0);
    expect(summary.turns24h).toBe(20);
    // 19 × 100 ms + 1 × 2000 ms, with the 9 s turn from yesterday excluded.
    expect(summary.avgResponseMs).toBe(195);
    // Nearest rank over 20 samples is the 19th fastest, so a single outlier —
    // exactly 5% of the sample — is the one turn p95 is allowed to ignore.
    expect(summary.p95ResponseMs).toBe(100);
    expect(summary.errorRate).toBe(0);

    // A second slow turn puts the tail over 5% and p95 has to show it.
    turn("slow-2", T0 - 20_000, 2_000);
    expect(performanceSummary(T0).p95ResponseMs).toBe(2_000);
  });

  it("counts an unsuccessful turn against the error rate and out of the timings", () => {
    turn("ok-1", T0 - 10_000, 500);
    turn("ok-2", T0 - 9_000, 500);
    turn("failed", T0 - 8_000, 30_000, false);

    const summary = performanceSummary(T0);
    // Every completed turn is a turn, so the card's two numbers reconcile:
    // 3 turns, a third of them failed, is the one failure.
    expect(summary.turns24h).toBe(3);
    expect(summary.errorRate).toBeCloseTo(1 / 3);
    // The 30 s failure is not a response time and must not move the average.
    expect(summary.avgResponseMs).toBe(500);
  });

  // Drivers emit `runtime.error` for every tool a bot's permissions refuse and
  // then carry on; the fatal ones always settle into a failed `turn.completed`.
  // Counting them would score a denied `rm` as a broken turn.
  it("ignores a mid-turn runtime error and keeps the turn it belongs to intact", () => {
    recordTurnEvent(started("t-1"), T0 - 5_000);
    recordTurnEvent(failed("t-1"), T0 - 4_500);
    recordTurnEvent(failed("t-1"), T0 - 4_000);
    recordTurnEvent(completed("t-1"), T0 - 3_000);

    const summary = performanceSummary(T0);
    expect(summary.turns24h).toBe(1);
    expect(summary.errorRate).toBe(0);
    expect(summary.avgResponseMs).toBe(2_000);
  });

  it("sums token usage over the window and drops yesterday's", () => {
    recordTurnEvent(tokens(1_000, 200), T0 - 25 * 60 * 60 * 1000);
    recordTurnEvent(tokens(300, 40), T0 - 60_000);
    recordTurnEvent(tokens(10, 5), T0 - 30_000);
    expect(performanceSummary(T0).tokens24h).toBe(355);
  });

  it("reports zeroes rather than NaN on a server that has run no turns", () => {
    expect(performanceSummary(T0)).toMatchObject({ avgResponseMs: 0, p95ResponseMs: 0, turns24h: 0, tokens24h: 0, errorRate: 0 });
  });

  it("keeps a turn whose start was lost out of the timings but inside the counts", () => {
    recordTurnEvent(completed("orphan"), T0 - 1_000);
    turn("timed", T0 - 500, 250);
    const summary = performanceSummary(T0);
    expect(summary.turns24h).toBe(2);
    expect(summary.avgResponseMs).toBe(250);
  });
});

const USERS: AdminUser[] = [
  { id: "usr_owner", name: "Kacper", username: "kacper", email: "k@example.test", role: "owner", createdAt: 1, lastSeenAt: T0 - 5_000, disabled: false },
  { id: "usr_member", name: "Bartek", username: "bartek", email: null, role: "member", createdAt: 2, lastSeenAt: null, disabled: false },
  { id: "usr_gone", name: "Ex", username: "ex", email: null, role: "member", createdAt: 3, lastSeenAt: T0 - 99_000, disabled: true },
];

function stubDeps(overrides: Record<string, unknown> = {}) {
  const transcripts: Record<string, Array<{ role: string; userId?: string }>> = {
    "th-1": [
      { role: "user", userId: "usr_owner" },
      { role: "bot" },
      { role: "user", userId: "usr_member" },
      { role: "user" },
    ],
    "th-2": [
      { role: "user", userId: "usr_owner" },
      { role: "user", userId: "usr_owner" },
      { role: "bot", userId: "usr_owner" },
    ],
  };
  return {
    identity: {
      usersWithActivity: () => USERS,
      recentAudit: () => [
        { at: T0 - 1_000, action: "user.disabled", userId: "usr_owner", target: "usr_gone" },
        { at: T0 - 2_000, action: "server.created", userId: null, target: "mbs_x" },
      ],
      getMeta: (key: string) => (key === "server.publicAddress" ? "http://[2a00::1]:8799" : null),
    },
    store: {
      bots: [
        { id: "b1", threadId: "th-1", visibility: "private", ownerId: "usr_owner", busy: true },
        { id: "b2", threadId: "th-2", visibility: "public", ownerId: "usr_member" },
        { id: "b3", threadId: "th-missing", ownerId: "usr_owner" },
      ],
      messagesFor: (threadId: string) => transcripts[threadId] ?? [],
    },
    server: { getConnections: (cb: (error: Error | null, count: number) => void) => cb(null, 7) },
    tlsFingerprint: "AA:BB",
    now: () => T0,
    gpuBinary: "multibot-no-such-gpu-binary",
    ...overrides,
  };
}

describe("adminOverview", () => {
  it("tallies each user's own messages and carries last-seen through", async () => {
    const overview = await adminOverview(stubDeps());
    expect(overview.users.map((user) => [user.username, user.messages, user.botsOwned, user.lastSeenAt])).toEqual([
      ["kacper", 3, 2, T0 - 5_000],
      ["bartek", 1, 1, null],
      ["ex", 0, 0, T0 - 99_000],
    ]);
    // A disabled profile stays in the table — that is how it gets re-enabled.
    expect(overview.users[2].disabled).toBe(true);
  });

  it("describes the fleet, the machine and the audit trail in one payload", async () => {
    const overview = await adminOverview(stubDeps());
    expect(overview.bots).toEqual({ total: 3, busy: 1, byVisibility: { public: 1, team: 1, private: 1 } });
    expect(overview.server.connectionsActive).toBe(7);
    expect(overview.server.publicAddress).toBe("http://[2a00::1]:8799");
    expect(overview.server.addressVerified).toBe(false);
    expect(overview.server.tlsFingerprint).toBe("AA:BB");
    expect(overview.server.cpuCount).toBeGreaterThan(0);
    expect(overview.server.ram.usedBytes).toBeGreaterThan(0);
    expect(overview.server.ram.usedBytes).toBeLessThanOrEqual(overview.server.ram.totalBytes);
    expect(overview.server.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(overview.audit[0]).toEqual({ at: T0 - 1_000, action: "user.disabled", userId: "usr_owner", target: "usr_gone", userName: "Kacper" });
    // Server-generated audit rows belong to nobody and must not invent a name.
    expect(overview.audit[1].userName).toBeNull();
  });

  it("survives an identity store that has never recorded an address", async () => {
    const deps = stubDeps();
    const overview = await adminOverview({ ...deps, identity: { ...deps.identity, getMeta: undefined } });
    expect(overview.server.publicAddress).toBeNull();
    expect(overview.server.addressVerified).toBe(false);
  });

  it("scans every transcript once per minute, not once per request", async () => {
    let scans = 0;
    const deps = stubDeps();
    const counting = { ...deps, store: { ...deps.store, messagesFor: (threadId: string) => (scans++, deps.store.messagesFor(threadId)) } };
    await adminOverview(counting);
    await adminOverview(counting);
    expect(scans).toBe(3);
  });
});

describe("gpuInfo", () => {
  it("is null when no NVIDIA tooling is installed", async () => {
    expect(await gpuInfo(T0, "multibot-no-such-gpu-binary")).toBeNull();
  });
});
