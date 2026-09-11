// Zgłoszenie Kacpra 10.09.2026, bot „Ogar", 16:23: napisał do bota, nie dostał
// NICZEGO — ani odpowiedzi, ani znaku, że bot pracuje. Log telefonu pokazał
// turę, która przeszła całą drogę i skończyła się `task_complete` z pustą
// odpowiedzią końcową (`AgentMessage text: ""`). Harness dostaje wtedy zero
// zdarzeń `assistant_text`, więc w transkrypcie nie ląduje nic, `busy` gaśnie i
// dla człowieka jest to nie do odróżnienia od zgubionej wiadomości.
//
// Test jedzie po HTTP przeciwko PRAWDZIWEMU serwerowi z atrapą CLI, która
// kończy turę bez jednego kawałka tekstu.
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
  home = mkdtempSync(join(tmpdir(), "mb-silent-turn-test-"));
  mkdirSync(join(home, ".multibot"), { recursive: true });
  writeFileSync(
    join(home, ".multibot", "config.json"),
    JSON.stringify({
      instances: {
        fake: {
          driver: "grokAgent",
          displayName: "Fake",
          // Tryb NA INSTANCJI: sterownik startuje CLI z własnym środowiskiem,
          // więc zmienna podana procesowi serwera nigdy do atrapy nie dociera.
          environment: { FAKE_ACP_MODE: "silent" },
          config: { cli: FAKE_CLI, fullAuto: true },
        },
        ask: {
          driver: "grokAgent",
          displayName: "Ask",
          environment: {
            FAKE_ACP_MODE: "ask-user",
            FAKE_ACP_ASK_MULTIPLE: "1",
            FAKE_ACP_ASK_CHOICES: "A|B|C|D",
            FAKE_ACP_ASK_DETAIL: "Pick every one that fits.",
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* jeszcze nie wstał */
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

describe("tura bez ani jednego słowa", () => {
  it(
    "zostawia widoczny ślad w czacie zamiast ciszy",
    async () => {
      const created = await api("POST", "/api/bots");
      expect(created.status).toBe(201);
      const id = created.body.bot.id;
      expect(
        (await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "fake", model: "fake-model" } })).status,
      ).toBe(200);

      const before = (await getBot(id)).messages.length;
      expect((await api("POST", `/api/bots/${id}/messages`, { text: "zapisz to sobie" })).status).toBe(202);

      let bot = await getBot(id);
      for (let i = 0; i < 200 && (bot.busy || bot.messages.length <= before + 1); i++) {
        await wait(100);
        bot = await getBot(id);
      }
      expect(bot.busy, `tura nie skończyła się. stderr:\n${stderr.slice(-2000)}`).toBe(false);

      // Przed poprawką po wiadomości użytkownika NIE BYŁO NIC: ostatnią
      // wiadomością w wątku zostawał jego własny tekst.
      const last = bot.messages.at(-1);
      expect(last.role, `czat skończył się na wiadomości użytkownika — cisza po turze`).toBe("bot");
      expect(last.kind).toBe("text");
      expect(String(last.text)).toContain("without an answer");
    },
    45_000,
  );
});

describe("karta pytania", () => {
  it(
    "pytanie jest TYTUŁEM karty, tło idzie pod spodem, a wielokrotny wybór wraca jako lista etykiet",
    async () => {
      const created = await api("POST", "/api/bots");
      expect(created.status).toBe(201);
      const id = created.body.bot.id;
      expect(
        (await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "ask", model: "fake-model" } })).status,
      ).toBe(200);
      expect((await api("POST", `/api/bots/${id}/messages`, { text: "zapytaj mnie" })).status).toBe(202);

      const deadline = Date.now() + 25_000;
      let card: any;
      let cardMessageId = "";
      for (;;) {
        const bot = await getBot(id);
        const held = bot?.messages.find((m: any) => m.card?.requestId);
        card = held?.card;
        cardMessageId = held?.id ?? "";
        if (card) break;
        if (Date.now() > deadline) throw new Error(`brak karty pytania. stderr:\n${stderr.slice(-2000)}`);
        await wait(200);
      }
      expect(card.title).toBe("Which database?");
      expect(card.subtitle).toBe("Pick every one that fits.");
      expect(card.multiple).toBe(true);
      expect(card.options).toEqual(["A", "B", "C", "D"]);

      // Wybór C i D wraca do modelu jako lista etykiet — dokładnie to, co
      // rysuje karta pokwitowania.
      expect(
        (await api("POST", `/api/bots/${id}/respond`, {
          requestId: card.requestId,
          behavior: "answer",
          message: "C, D",
        })).status,
      ).toBe(200);

      let bot = await getBot(id);
      for (let i = 0; i < 200 && bot.busy; i++) {
        await wait(100);
        bot = await getBot(id);
      }
      expect(bot.busy).toBe(false);
      expect(
        bot.messages.some((m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("owner says: C, D")),
      ).toBe(true);

      // Kartę domyka SERWER, nie klient: pokwitowanie („C, D" + „odebrane")
      // musi być w transkrypcie także dla okna, które nie klikało, i po
      // przeładowaniu. Wcześniej wpisywał to osobny PATCH z klienta.
      const settled = bot.messages.find((m: any) => m.id === cardMessageId).card;
      expect(settled.answered).toBe("C, D");
      expect(settled.delivered).toBe(true);
      expect(settled.dismissed).toBeFalsy();
    },
    45_000,
  );
});
