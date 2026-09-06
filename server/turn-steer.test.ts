// Auto-steering wiadomości użytkownika, na prawdziwym harnessie z atrapą
// codeksowego app-servera (FAKE_CODEX_MODE=steer — tura wisi po `turn/start`
// i kończy się dopiero po udanym `turn/steer`).
//
// Skarga, którą to zamyka: „bot pracuje 10 minut, a moja poprawka czeka w
// kolejce, aż skończy robić nie to". Dla GPT-6 Astra korekta wchodzi do TEJ
// tury; każdy inny model zostaje przy dotychczasowej kolejce, bo tylko codex
// ma `turn/steer` i tylko Astra jest na tym przetestowana.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapAccessToken } from "./testing/identity.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = "";
const DEBOUNCE_MS = 200;

describe("auto-steer podczas trwającej tury (atrapa codeksa)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const bots = async () => (await api("GET", "/api/bots")).body.bots as any[];

  const waitFor = async (what: string, budgetMs: number, ok: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (await ok()) return;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const newBot = async (name: string, model: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId: "steerable", model } });
    return bot.id as string;
  };

  /** Tura naprawdę ŻYJE dopiero, gdy atrapa zgłosiła narzędzie — samo `busy`
   *  zapala już przyjęcie wiadomości, więc na nim nie da się polegać. */
  const turnIsLive = async (botId: string) => {
    const bot = (await bots()).find((b) => b.id === botId);
    return Boolean(bot?.messages?.some((m: { kind: string }) => m.kind === "activity"));
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-steer-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: { steerable: { driver: "codex", displayName: "Steerable", config: { cli: FAKE_CLI, fullAuto: true } } },
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
        OMB_HOST: "127.0.0.1",
        MULTIBOT_COMPUTER: "off",
        OMB_TURN_DEBOUNCE_MS: String(DEBOUNCE_MS),
        FAKE_CODEX_MODE: "steer",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* jeszcze nie wstał */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    TOKEN = await bootstrapAccessToken(BASE, home);
    for (const seeded of await bots()) await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error;
    }
  });

  it(
    "GPT-6 Astra zajęta pracą: wiadomość wchodzi do trwającej tury (delivery: steered)",
    async () => {
      const astra = await newBot("Astra", "gpt-6-astra");
      expect((await api("POST", `/api/bots/${astra}/messages`, { text: "przejrzyj repo" })).body.delivery).toBe("queued");
      await waitFor("tura Astry ruszyła", 25_000, () => turnIsLive(astra));

      const correction = await api("POST", `/api/bots/${astra}/messages`, { text: "użyj ripgrepa" });
      expect(correction.status).toBe(202);
      expect(correction.body.delivery).toBe("steered");
      expect(correction.body.queued).toBe(false);
      // bańka użytkownika ląduje w wątku tak samo jak przy kolejce
      const bot = (await bots()).find((b) => b.id === astra);
      expect(bot.messages.some((m: any) => m.role === "user" && m.text === "użyj ripgrepa")).toBe(true);
      // steering domyka turę w atrapie — bot wraca do wolnych bez drugiej tury
      await waitFor("tura Astry się skończyła", 25_000, async () => !(await bots()).find((b) => b.id === astra)?.busy);
    },
    60_000,
  );

  it(
    "inny model na tym samym driverze zostaje przy kolejce (delivery: queued)",
    async () => {
      const sol = await newBot("Sol", "gpt-5.6-sol");
      expect((await api("POST", `/api/bots/${sol}/messages`, { text: "przejrzyj repo" })).body.delivery).toBe("queued");
      await waitFor("tura Sola ruszyła", 25_000, () => turnIsLive(sol));

      const second = await api("POST", `/api/bots/${sol}/messages`, { text: "użyj ripgrepa" });
      expect(second.status).toBe(202);
      expect(second.body.delivery).toBe("queued");
      expect(second.body.queued).toBe(true);
      // tura Sola dalej wisi — nikt jej nie wysterował
      expect((await bots()).find((b) => b.id === sol)?.busy).toBe(true);
    },
    60_000,
  );

  it(
    "wiadomość z załącznikiem NIE jest sterowana, nawet u Astry",
    async () => {
      const astra = await newBot("Astra2", "gpt-6-astra");
      expect((await api("POST", `/api/bots/${astra}/messages`, { text: "start" })).body.delivery).toBe("queued");
      await waitFor("tura Astry2 ruszyła", 25_000, () => turnIsLive(astra));

      const upload = await fetch(`${BASE}/api/bots/${astra}/attachments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "text/plain",
          "x-file-name": encodeURIComponent("notes.txt"),
        },
        body: "kolumna\n1\n",
      });
      expect(upload.status).toBe(201);
      const file = (await upload.json()) as { id: string };

      const withFile = await api("POST", `/api/bots/${astra}/messages`, { text: "spójrz", attachmentIds: [file.id] });
      expect(withFile.status).toBe(202);
      expect(withFile.body.delivery).toBe("queued");
    },
    60_000,
  );
});
