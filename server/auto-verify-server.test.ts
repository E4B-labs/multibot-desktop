// Autoweryfikacja end to end: prawdziwy serwer harnessu z driverem grokAgent
// wycelowanym w atrapę ACP w trybie `permission`, czyli dokładnie ta droga,
// którą w apce idzie prośba o zgodę (session/request_permission → kanoniczne
// `request.opened` → karta w czacie → POST /api/bots/:id/respond).
//
// Test istnieje dlatego, że jednostkowy `auto-verify.test.ts` sprawdza samą
// decyzję, a nie to, czy ktokolwiek ją WYKONA: cała wartość tej funkcji siedzi
// w tym, że zgoda naprawdę wraca do dostawcy i tura dochodzi do końca bez
// człowieka. Reguły ustawiamy przez `PUT /api/config`, więc przy okazji
// przechodzi cały kanał zapisu, którym posługuje się UI.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapAccessToken } from "./testing/identity.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = "";

describe("autoweryfikacja e2e (atrapa ACP prosząca o zgodę)", () => {
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

  /** Bot na atrapie proszącej o zgodę. `fullAuto` zostaje wyłączone, bo
   *  inaczej driver zatwierdziłby akcję sam i `request.opened` nigdy by nie
   *  wyszło — autoweryfikacja filtruje tylko to, co do nas dociera. */
  const newBot = async (name: string, instanceId = "grokPerm") => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "fake-model" } });
    return bot.id as string;
  };

  /** Karta prośby o zgodę (nie onboardingowa — tamta nie ma `requestId`). */
  const waitForCard = async (botId: string) => {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);
      const card = bot?.messages.find((m: any) => m.card?.requestId)?.card;
      if (card) return card;
      if (Date.now() > deadline) throw new Error(`brak karty zgody. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const waitUntilIdle = async (botId: string) => {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);
      if (bot && !bot.busy) return bot;
      if (Date.now() > deadline) throw new Error(`tura nie domknęła się. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-autoverify-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          grokPerm: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          // drugi dostawca WYŁĄCZNIE po to, żeby dało się wypuścić prośbę
          // typu "question" — ACP zna tylko zgody na narzędzia. Tryb atrapy
          // idzie env-em serwera, bo driver codeksa nie przekazuje dziecku
          // `environment` instancji (celowa higiena kluczy).
          codexAsk: {
            driver: "codex",
            config: { cli: FAKE_CODEX, fullAuto: false },
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
        FAKE_CODEX_MODE: "question",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    TOKEN = await bootstrapAccessToken(BASE, home);
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

  // Domyślny stan (włączona, zero reguł) NIE MOŻE zmienić niczego, co działało
  // wcześniej — inaczej byłaby to cicha zmiana zachowania istniejących botów.
  it(
    "bez pasującej reguły pyta jak dotąd i czeka na człowieka",
    async () => {
      const botId = await newBot("Pytacz");
      expect((await api("POST", `/api/bots/${botId}/messages`, { text: "zrób coś" })).status).toBe(202);

      const card = await waitForCard(botId);
      expect(card.title).toBe("Approval needed");
      expect(card.answered).toBeUndefined();
      expect(card.subtitle).toBe("echo hi");

      // tura naprawdę stoi: dopiero ręczna zgoda ją domyka
      expect((await api("POST", `/api/bots/${botId}/respond`, { requestId: card.requestId, behavior: "allow" })).status).toBe(200);
      await waitUntilIdle(botId);
    },
    45_000,
  );

  it(
    "reguła na allow zatwierdza sama, ale karta i tak trafia do czatu",
    async () => {
      const saved = await api("PUT", "/api/config", {
        autoVerify: { enabled: true, rules: [{ id: "echo", when: "echo hi", decision: "allow" }] },
      });
      expect(saved.status).toBe(200);

      const botId = await newBot("Zaufany");
      expect((await api("POST", `/api/bots/${botId}/messages`, { text: "zrób coś" })).status).toBe(202);

      // NIEPODWAŻALNE: tura kończy się bez żadnego /respond od człowieka
      await waitUntilIdle(botId);
      const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);
      expect(bot.messages.some((m: any) => m.kind === "text" && m.role === "bot")).toBe(true);

      const card = bot.messages.find((m: any) => m.card?.requestId).card;
      expect(card.title).toBe("Auto-approved");
      expect(card.answered).toBe("Allow");
      // karta MUSI zostać widoczna — `dismissed` chowa ją w UI całkowicie
      expect(card.dismissed).toBeFalsy();
      // z karty ma być widać, KTÓRA reguła to przepuściła
      expect(card.subtitle).toContain("echo hi");
      expect(card.subtitle).toContain('Auto-approved by rule: "echo hi"');
    },
    45_000,
  );

  it(
    "reguła obok tematu nie przepuszcza akcji",
    async () => {
      await api("PUT", "/api/config", {
        autoVerify: { enabled: true, rules: [{ id: "mail", when: "odpowiadaj na maile", decision: "allow" }] },
      });

      const botId = await newBot("Ostrożny");
      await api("POST", `/api/bots/${botId}/messages`, { text: "zrób coś" });
      const card = await waitForCard(botId);
      expect(card.answered).toBeUndefined();
      expect(card.title).toBe("Approval needed");

      await api("POST", `/api/bots/${botId}/respond`, { requestId: card.requestId, behavior: "deny" });
      await waitUntilIdle(botId);
    },
    45_000,
  );

  it(
    "wyłączona autoweryfikacja przepuszcza wszystko i mówi o tym wprost",
    async () => {
      expect((await api("PUT", "/api/config", { autoVerify: { enabled: false, rules: [] } })).status).toBe(200);

      const botId = await newBot("Bez nadzoru");
      await api("POST", `/api/bots/${botId}/messages`, { text: "zrób coś" });
      await waitUntilIdle(botId);

      const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);
      const card = bot.messages.find((m: any) => m.card?.requestId).card;
      expect(card.answered).toBe("Allow");
      expect(card.subtitle).toContain("Auto-approved: auto-verify is switched off.");
    },
    45_000,
  );

  // Autoweryfikacja dotyczy ZGÓD, nie pytań. Test jedzie przy wyłączonej
  // autoweryfikacji, czyli w stanie, w którym decyzja dla KAŻDEJ akcji brzmi
  // "allow" — gdyby zabrakło warunku na `requestType`, bot odpowiedziałby
  // sobie na własne pytanie i człowiek nigdy by go nie zobaczył.
  it(
    "pytania bota zostają dla człowieka, choćby autoweryfikacja przepuszczała wszystko",
    async () => {
      expect((await api("PUT", "/api/config", { autoVerify: { enabled: false, rules: [] } })).status).toBe(200);

      const botId = await newBot("Ciekawski", "codexAsk");
      expect((await api("POST", `/api/bots/${botId}/messages`, { text: "zdecyduj" })).status).toBe(202);

      const card = await waitForCard(botId);
      expect(card.title).toBe("Your bot has a question");
      expect(card.answered).toBeUndefined();
      expect(card.options).toEqual(["Postgres", "SQLite"]);

      // pytanie naprawdę czeka na człowieka — dopiero jego odpowiedź domyka turę
      expect((await api("POST", `/api/bots/${botId}/respond`, {
        requestId: card.requestId,
        behavior: "answer",
        message: "Postgres",
      })).status).toBe(200);
      await waitUntilIdle(botId);
    },
    45_000,
  );
});
