// /goal sessions, end to end: boots the real harness server with the
// grokAgent driver pointed at the fake ACP CLI in "goal" mode (first turn
// reports progress, second ends with the [GOAL COMPLETE] marker). Exercises:
// POST /api/bots/:id/messages with "/goal task" → the harness acks, runGoal
// loops, progress pills land on the chat, and the goal settles to "done"
// with a final report. Also: /goal without a task shows usage, /goal --resume
// continues the last unfinished goal.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapAccessToken } from "./testing/identity.ts";
import { parseGoalCommand } from "./goals.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = "";

let child: ChildProcess;
let home: string;
let counterFile: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const getBot = async (id: string) => {
  const { body } = await api("GET", "/api/bots");
  return (body.bots as any[]).find((b) => b.id === id);
};

const waitFor = async (fn: () => Promise<boolean>, ms = 25_000, what = "condition") => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr:\n${stderr.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

beforeAll(async () => {
  chmodSync(FAKE_CLI, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-goals-test-"));
  counterFile = join(home, "goal-counter.txt");
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      instances: {
        grok: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "goal", FAKE_ACP_GOAL_COUNTER: counterFile },
          config: { cli: FAKE_CLI, fullAuto: true },
        },
      },
    }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
        OMB_ONBOARDING_TURN: "0",
      MULTIBOT_COMPUTER: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  TOKEN = await bootstrapAccessToken(BASE);
}, 30_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows handle release races — temp dir cleanup must not fail the run */
  }
});

describe("goal sessions", () => {
  it("shows usage for a bare /goal and rejects nothing", async () => {
    const selection = { instanceId: "grok", model: "fake-model" };
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name: "Goal Bot", modelSelection: selection });

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "/goal" });
    expect(sent.status).toBe(200);
    expect(sent.body.command).toBe("goal");
    const after = await getBot(bot.id);
    const reply = after.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
    expect(reply.text).toContain("Usage: /goal");
    expect(reply.text).toContain("--plan");
    expect(reply.text).toContain("--resume");
  });

  it(
    "runs a goal to done across turns, posts progress pills, and reports",
    async () => {
      writeFileSync(counterFile, "0");
      const selection = { instanceId: "grok", model: "fake-model" };
      const bot = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${bot.id}`, { name: "Goal Runner", modelSelection: selection });

      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "/goal napisz raport o kawie" });
      expect(sent.status).toBe(200);
      expect(sent.body.command).toBe("goal");
      const ack = (await getBot(bot.id)).messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(ack.text).toContain("Goal started: napisz raport o kawie");

      // two fake turns → settled "done"; the second one carries the marker
      await waitFor(async () => {
        const b = await getBot(bot.id);
        return b.messages.some((m: any) => m.kind === "event" && m.event?.type === "goal-progress" && m.event.value.includes("goal complete"));
      }, 30_000, "goal done pill");

      const after = await getBot(bot.id);
      const pills = after.messages.filter((m: any) => m.kind === "event" && m.event?.type === "goal-progress");
      expect(pills.length).toBeGreaterThanOrEqual(2); // start + done (progress step may merge)
      const donePill = pills.find((m: any) => m.event.value.includes("goal complete"));
      expect(donePill).toBeTruthy();

      // final report message
      const report = after.messages.findLast((m: any) => m.kind === "text" && m.role === "bot" && m.text.includes("**Goal achieved**"));
      expect(report).toBeTruthy();
      expect(report.text).toContain("napisz raport o kawie");
      expect(report.text).toContain("/goal --resume");
      // not busy anymore — the loop released the bot
      expect(after.busy).toBeFalsy();
    },
    45_000,
  );

  it(
    "resumes the last unfinished goal with /goal --resume",
    async () => {
      const selection = { instanceId: "grok", model: "fake-model" };
      const bot = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${bot.id}`, { name: "Goal Resumer", modelSelection: selection });
      writeFileSync(counterFile, "0");
      // --turns 1: the first fake turn reports progress without the marker, so
      // the turn budget is hit and the goal settles "failed" — still resumable.
      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "/goal --turns 1 zbierz dane o cenach" });
      expect(sent.body.command).toBe("goal");
      await waitFor(async () => {
        const b = await getBot(bot.id);
        return b.messages.some((m: any) => m.kind === "event" && m.event?.type === "goal-progress" && m.event.value.includes("step 1/1"));
      }, 30_000, "budget-failed goal");

      // a fresh /goal --resume continues that goal → ack names it
      const resumed = await api("POST", `/api/bots/${bot.id}/messages`, { text: "/goal --resume" });
      expect(resumed.status).toBe(200);
      const after = await getBot(bot.id);
      const ack = after.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(ack.text).toContain("Resuming goal");
    },
    45_000,
  );
});

describe("domyślne budżety celu", () => {
  it("daje dziesięć tur, a dwa pozostałe limity ich nie ucinają", () => {
    // Obietnica dla użytkownika brzmi „dziesięć rund". Budżet kroków i czasu
    // był kiedyś ciaśniejszy niż ta obietnica i zabijał cel po drugiej turze.
    const { options } = parseGoalCommand("/goal zbierz oferty")!;
    expect(options.turns).toBe(10);
    expect(options.steps / options.turns).toBeGreaterThanOrEqual(20);
    expect(options.time / options.turns).toBeGreaterThanOrEqual(5);
  });
});