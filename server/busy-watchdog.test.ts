// The busy watchdog is supposed to catch a provider that went SILENT — its own
// comment says "brak turn.completed przez 70 s". It was armed only at the start
// of a turn and after steering, so what it actually measured was the LENGTH of
// the turn: every turn longer than the ceiling — that is, every agentic turn
// with a few tool calls — had `busy` force-cleared out from under a provider
// that was still working. The bot went back to the free pool, the composer
// unlocked, and the mascot above it went dark mid-run.
//
// This drives a real server over HTTP with a fake CLI that talks steadily for
// well past the ceiling, then finishes. `busy` must survive the whole thing.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapAccessToken } from "./testing/identity.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");

// Ceiling well under the turn: 8 beats every 300 ms is ~2.4 s of provider
// chatter against a 700 ms ceiling, so the old code cleared `busy` three times
// over before the turn ended.
const WATCHDOG_MS = 700;
const BEATS = 8;
const EVERY_MS = 300;

let port = 0;
let base = "";
let TOKEN = "";
let child: ChildProcess;
let home = "";
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      port = (probe.address() as { port: number }).port;
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
  base = `https://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "omb-watchdog-test-"));
  mkdirSync(join(home, ".multibot"), { recursive: true });
  writeFileSync(
    join(home, ".multibot", "config.json"),
    JSON.stringify({
      instances: {
        fake: {
          driver: "grokAgent",
          displayName: "Fake",
          // Na instancji, nie w env serwera: sterownik startuje CLI z wlasnym
          // srodowiskiem, wiec tryb podany procesowi serwera nigdy do niego nie
          // docieral i atrapa milczala przez cala ture.
          environment: {
            FAKE_ACP_MODE: "slow",
            FAKE_ACP_SLOW_BEATS: String(BEATS),
            FAKE_ACP_SLOW_EVERY_MS: String(EVERY_MS),
          },
          config: { cli: FAKE_CLI, fullAuto: true },
        },
      },
    }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { windowsHide: true,
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      MULTIBOT_PORT: String(port),
      MULTIBOT_ONBOARDING_TURN: "0",
      MULTIBOT_COMPUTER: "off",
      MULTIBOT_HOST: "127.0.0.1",
      MULTIBOT_TURN_DEBOUNCE_MS: "0",
      MULTIBOT_BUSY_WATCHDOG_MS: String(WATCHDOG_MS),
      // One slot: the second bot's turn has to WAIT for the first one before the
      // provider says a word, which is the pre-start silence the watchdog must
      // not mistake for a hung provider.
      MULTIBOT_MAX_PARALLEL_TURNS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await wait(150);
  }
  TOKEN = await bootstrapAccessToken(base, home);
}, 30_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(home, { recursive: true, force: true });
      break;
    } catch {
      await wait(200);
    }
  }
});

describe("busy watchdog", () => {
  it(
    "measures provider silence, not turn length — a long talking turn keeps busy to the end",
    async () => {
      const created = await api("POST", "/api/bots");
      expect(created.status).toBe(201);
      const id = created.body.bot.id;
      // Bez tego bot rusza na domyslnym dostawcy, ktorego na maszynie testowej
      // nie ma: `busy` zapala sie, atrapa nie odzywa sie ani razu i watchdog
      // gasi ture, ktora nigdy nie ruszyla.
      expect((await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "fake", model: "fake-model" } })).status).toBe(200);

      const sent = await api("POST", `/api/bots/${id}/messages`, { text: "grind on this" });
      expect(sent.status).toBe(202);

      let running = await getBot(id);
      for (let i = 0; i < 60 && !running.busy; i++) {
        await wait(50);
        running = await getBot(id);
      }
      expect(running.busy).toBe(true);

      // Watch across several ceilings' worth of a still-running turn. The old
      // code dropped `busy` at the first one.
      const until = Date.now() + WATCHDOG_MS * 3;
      while (Date.now() < until) {
        const bot = await getBot(id);
        expect(bot.busy, `busy was cleared mid-turn — the watchdog is timing the turn, not the silence`).toBe(true);
        await wait(WATCHDOG_MS / 4);
      }

      // …and the turn still ends by itself, with the provider's own text.
      let done = await getBot(id);
      for (let i = 0; i < 80 && done.busy; i++) {
        await wait(100);
        done = await getBot(id);
      }
      expect(done.busy).toBe(false);
      expect(done.messages.some((m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("tick"))).toBe(true);
    },
    60_000,
  );

  it(
    "does not time the wait for a turn slot — a turn queued behind another bot keeps busy and still answers",
    async () => {
      const mk = async () => {
        const created = await api("POST", "/api/bots");
        expect(created.status).toBe(201);
        const id = created.body.bot.id;
        expect((await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "fake", model: "fake-model" } })).status).toBe(200);
        return id as string;
      };
      const first = await mk();
      const second = await mk();
      expect((await api("POST", `/api/bots/${first}/messages`, { text: "hold the only slot" })).status).toBe(202);
      let holder = await getBot(first);
      for (let i = 0; i < 60 && !holder.busy; i++) {
        await wait(50);
        holder = await getBot(first);
      }
      expect(holder.busy).toBe(true);
      // The second bot is accepted at once (busy), but its provider cannot start
      // until the first turn — ~2.4 s, several ceilings — releases the slot.
      expect((await api("POST", `/api/bots/${second}/messages`, { text: "wait your turn" })).status).toBe(202);
      const until = Date.now() + WATCHDOG_MS * 3;
      while (Date.now() < until) {
        const bot = await getBot(second);
        expect(bot.busy, `busy was cleared while the turn was still waiting for a slot`).toBe(true);
        await wait(WATCHDOG_MS / 4);
      }
      let done = await getBot(second);
      for (let i = 0; i < 100 && done.busy; i++) {
        await wait(100);
        done = await getBot(second);
      }
      expect(done.busy).toBe(false);
      expect(done.messages.some((m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("tick"))).toBe(true);
      // The old code drained the queue into a thread whose turn had not even
      // started, which the driver refused with this exact pill.
      expect(done.messages.some((m: any) => m.kind === "activity" && /already running/.test(m.tool?.name ?? ""))).toBe(false);
    },
    60_000,
  );
});
