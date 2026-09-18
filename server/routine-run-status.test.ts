// Wiring wyniku przebiegu rutyny, na prawdziwym serwerze i prawdziwym torze
// zdarzeń. Dwie rzeczy, które da się sprawdzić TYLKO tutaj, bo mieszkają
// w `server/index.ts`, nie w `HarnessRoutines`:
//
//  1. Udana tura rutyny naprawdę domyka wpis na `ok`. `endTurnPush` woła
//     `settleRun` pod bramką origin i wyłącznie dla `origin === "routine"`,
//     więc pomyłka w tej bramce cicho zabiera „sukces" z historii.
//  2. Tura ubita watchdogiem zostaje `error` z powodem `watchdog` — także po
//     tym, jak SPÓŹNIONE `turn.completed` w końcu przyjdzie. Watchdog czyści
//     `turnOrigin`, więc spóźnione zdarzenie musi odbić się od bramki i nie
//     przepisać historii na „ok".
//
// Atrapa CLI milczy dłużej niż pułap watchdoga, a potem mimo wszystko kończy
// turę — czyli dokładnie ten spóźniony przypadek.
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

const WATCHDOG_MS = 700;
/** Cisza dostawcy dłuższa niż pułap: watchdog gasi turę, a `turn.completed`
 * przychodzi dopiero potem. */
const LATE_MS = 2_600;

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bot = async (instanceId: string) => {
  const created = await api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const id = created.body.bot.id as string;
  expect((await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId, model: "fake-model" } })).status).toBe(200);
  return id;
};

const runs = async (botId: string, routineId: string) => {
  const listed = await api("GET", `/api/bots/${botId}/routines`);
  return (listed.body as any[]).find((r) => r.id === routineId)?.last_runs as
    | Array<{ status?: string; error?: string; reason?: string }>
    | undefined;
};

/** Czeka, aż przebieg przestanie być `queued` — czyli aż koniec tury dopisze wynik. */
const settled = async (botId: string, routineId: string, ms: number) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const history = await runs(botId, routineId);
    if (history?.[0] && history[0].status !== "queued") return history;
    if (Date.now() > deadline) return history;
    await wait(100);
  }
};

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
  home = mkdtempSync(join(tmpdir(), "mb-routine-status-"));
  mkdirSync(join(home, ".multibot"), { recursive: true });
  writeFileSync(
    join(home, ".multibot", "config.json"),
    JSON.stringify({
      instances: {
        // Tryb i czasy siedzą na INSTANCJI: sterownik startuje CLI z własnym
        // środowiskiem, więc env procesu serwera nigdy do atrapy nie dociera.
        quick: {
          driver: "grokAgent",
          displayName: "Quick",
          environment: { FAKE_ACP_MODE: "happy" },
          config: { cli: FAKE_CLI, fullAuto: true },
        },
        late: {
          driver: "grokAgent",
          displayName: "Late",
          environment: {
            FAKE_ACP_MODE: "slow",
            FAKE_ACP_SLOW_BEATS: "1",
            FAKE_ACP_SLOW_EVERY_MS: String(LATE_MS),
          },
          config: { cli: FAKE_CLI, fullAuto: true },
        },
      },
    }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    windowsHide: true,
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

describe("historia rutyny na żywym serwerze", () => {
  it("udana tura rutyny zostawia w historii `ok`, nie „w kolejce”", async () => {
    const id = await bot("quick");
    const made = await api("POST", `/api/bots/${id}/routines`, { name: "Digest", prompt: "summarize" });
    expect(made.status).toBe(201);
    const rid = made.body.id as string;

    expect((await api("POST", `/api/bots/${id}/routines/${rid}/run`)).status).toBe(200);
    const history = await settled(id, rid, 20_000);
    expect(history).toHaveLength(1);
    expect(history![0].status).toBe("ok");
    expect(history![0].error).toBeUndefined();
  }, 40_000);

  it("turę ubitą watchdogiem widać jako `error`, a spóźnione `turn.completed` tego nie przepisuje", async () => {
    const id = await bot("late");
    const made = await api("POST", `/api/bots/${id}/routines`, { name: "Hangs", prompt: "go quiet" });
    expect(made.status).toBe(201);
    const rid = made.body.id as string;

    expect((await api("POST", `/api/bots/${id}/routines/${rid}/run`)).status).toBe(200);
    const killed = await settled(id, rid, 15_000);
    expect(killed).toHaveLength(1);
    expect(killed![0]).toMatchObject({ status: "error", reason: "watchdog" });

    // …a teraz przychodzi spóźniony koniec tury, którą watchdog już zamknął
    await wait(LATE_MS + 2_000);
    const after = await runs(id, rid);
    expect(after).toHaveLength(1);
    expect(after![0]).toMatchObject({ status: "error", reason: "watchdog" });
    expect((await api("GET", `/api/bots/${id}`)).body.bot.busy).toBe(false);
  }, 60_000);
});
