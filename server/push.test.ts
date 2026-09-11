// Powiadomienia push, end to end: prawdziwy harness (jak w comms.test.ts) z
// atrapą CLI, a zamiast exp.host lokalny serwerek, który zbiera payloady
// (`MULTIBOT_EXPO_PUSH_URL`) i odpowiada ticketami jak exp.host.
//
// Od 11.09.2026 (K4) telefon brzęczy wtedy, gdy praca STANĘŁA na człowieku:
// karta z pytaniem, przypomnienie, `notify_user`. Reguła siedzi w
// `shouldNotify` (test jednostkowy: push-gate.test.ts), a ta suita pilnuje, że
// tak jest naprawdę na całej drodze: koniec tury i tura bot-bot milczą, CICHY
// PRZEBIEG RUTYNY milczy, rutyna która PYTA brzęczy, wyłączony przełącznik
// bota ucisza wszystko, ładunek jest dostarczalny na Androidzie, a ticket
// `DeviceNotRegistered` kasuje urządzenie z configu.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapAccessToken } from "./testing/identity.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let port = 0;
let base = "";
let TOKEN = "";
/** Token, na który atrapa exp.host odpowiada ticketem `DeviceNotRegistered`. */
const DEAD_TOKEN = "ExponentPushToken[dead]";

type Push = {
  to?: string;
  title: string;
  body: string;
  ttl?: number;
  priority?: string;
  channelId?: string;
  sound?: string;
  data?: { botId?: string; kind?: string };
};

describe("push na telefon (fake ACP fleet)", () => {
  let child: ChildProcess;
  let expo: Server;
  let pushPort = 0;
  let home: string;
  let stderr = "";
  let memberToken = "";
  const pushes: Push[] = [];

  const api = async (method: string, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  /** Czeka, aż warunek na zebranych pushach będzie spełniony (albo poddaje się). */
  const until = async (ok: () => boolean, ms = 15_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  };
  const kinds = (botId: string) => pushes.filter((p) => p.data?.botId === botId).map((p) => p.data?.kind);

  const newBot = async (name: string, instanceId: string): Promise<string> => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "fake-model" } });
    return bot.id;
  };

  /** Transkrypt bota — GET /api/bots zwraca boty razem z wiadomościami. */
  const botState = async (botId: string): Promise<any> =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);

  /** Urządzenia zapisane w configu serwera; pusto, gdy trafimy w moment zapisu. */
  const pushDevices = (): Record<string, { token?: string }> => {
    try {
      return JSON.parse(readFileSync(join(home, ".multibot", "config.json"), "utf8")).pushDevices ?? {};
    } catch {
      return {};
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        port = (probe.address() as { port: number }).port;
        probe.close((error) => error ? reject(error) : resolve());
      });
    });
    base = `https://127.0.0.1:${port}`;
    expo = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let batch: Push[] = [];
        try {
          const parsed = JSON.parse(raw);
          batch = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          /* nieistotne dla testu */
        }
        pushes.push(...batch);
        // ticket na wiadomość, w tej samej kolejności — tak samo jak exp.host
        const data = batch.map((m) =>
          m.to === DEAD_TOKEN
            ? { status: "error", message: "not a registered recipient", details: { error: "DeviceNotRegistered" } }
            : { status: "ok", id: "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" },
        );
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      expo.once("error", reject);
      expo.listen(0, "127.0.0.1", () => {
        pushPort = (expo.address() as { port: number }).port;
        resolve();
      });
    });

    home = mkdtempSync(join(tmpdir(), "multibot-push-test-"));
    mkdirSync(join(home, ".multibot"), { recursive: true });
    writeFileSync(
      join(home, ".multibot", "config.json"),
      JSON.stringify({
        instances: {
          happy: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true } },
          grokAsk: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-user" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokPeer: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokNotify: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "notify-user" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // bot woła `create_reminder` — ta sama droga, którą idzie model
          // proszony o „przypomnij mi o X"; termin podaje env, żeby test
          // wiedział, kiedy czekać
          grokReminder: {
            driver: "grokAgent",
            environment: {
              FAKE_ACP_MODE: "create-reminder",
              FAKE_ACP_REMINDER_TEXT: "dentysta",
              FAKE_ACP_REMINDER_IN_MS: "120000",
            },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokConnect: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "request-connection" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokConnectApp: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "request-connection", FAKE_ACP_CONNECTOR: "discord" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        MULTIBOT_PORT: String(port),
        MULTIBOT_ONBOARDING_TURN: "0",
        MULTIBOT_COMPUTER: "off",
        MULTIBOT_EXPO_PUSH_URL: `http://127.0.0.1:${pushPort}/push`,
        // takt przypomnień co pół sekundy: suita nie ma po co czekać 30 s
        // na każde odpalenie, a ścieżka jest ta sama
        MULTIBOT_REMINDER_TICK_MS: "500",
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
      await new Promise((r) => setTimeout(r, 150));
    }
    const setup = JSON.parse(readFileSync(join(home, ".multibot", "setup.json"), "utf8"));
    const values = await fetch(`${base}/api/setup/values`, { headers: { "x-multibot-setup": setup.setupToken } });
    const { serverName, serverPassword } = await values.json() as any;
    TOKEN = await bootstrapAccessToken(base, home);
    const member = await api("POST", "/api/auth/register", {
      username: "push-member", password: "push-member-password", displayName: "Member", serverName, serverPassword,
    });
    expect(member.status).toBe(201);
    memberToken = member.body.accessToken;
    await api("POST", "/api/devices/member-phone/push", { token: "ExponentPushToken[member]" }, memberToken);
    await api("POST", "/api/devices/test-phone/push", { token: "ExponentPushToken[test]" });
  }, 40_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    await new Promise<void>((r) => expo.close(() => r()));
    if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error;
    }
  });

  /** Ustawia przypomnienie za `seconds` sekund i czeka, aż odpali. Jedyna
   * ścieżka, która w ogóle wywołuje push — reszta suity używa jej, gdy
   * potrzebuje prawdziwego ładunku do obejrzenia. */
  async function fireReminder(botId: string, text: string, seconds = 2): Promise<Push> {
    const at = new Date(Date.now() + seconds * 1_000).toISOString();
    const created = await api("POST", "/api/reminders", { botId, text, at });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("pending");
    await until(() => kinds(botId).includes("reminder"), 20_000);
    return pushes.find((p) => p.data?.botId === botId && p.data?.kind === "reminder")!;
  }

  async function waitForReply(botId: string, count = 1): Promise<any> {
    let bot: any;
    await expect.poll(async () => {
      bot = await botState(botId);
      return !bot?.busy && bot?.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text).length >= count;
    }, { timeout: 30_000 }).toBe(true);
    return bot;
  }

  async function runOnce(botId: string): Promise<void> {
    const created = await api("POST", `/api/bots/${botId}/routines`, {
      name: "Scheduled report", prompt: "Check the report; request attention only if a decision cannot wait.",
      schedule: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect((await api("POST", `/api/bots/${botId}/routines/${created.body.id}/run`)).status).toBe(200);
    await waitForReply(botId);
  }

  it("one-shot scheduled work starts and finishes without a reminder push", async () => {
    const botId = await newBot("Scheduled worker", "happy");
    await runOnce(botId);
    expect(kinds(botId)).toEqual([]);
  }, 45_000);

  it("a routine can explicitly notify, with no automatic start/end push and dedupe across turns", async () => {
    const botId = await newBot("Routine escalation", "grokNotify");
    await api("PATCH", `/api/bots/${botId}`, { visibility: "private" });
    await runOnce(botId);
    await until(() => kinds(botId).includes("notify"));
    expect(kinds(botId)).toEqual(["notify"]);
    expect(pushes.filter((p) => p.data?.botId === botId).map((p) => p.to)).toEqual(["ExponentPushToken[test]"]);
    await api("POST", `/api/bots/${botId}/messages`, { text: "Check again" });
    const bot = await waitForReply(botId, 2);
    expect(bot.messages.some((m: any) => m.text?.includes('"collapsed": true'))).toBe(true);
    expect(kinds(botId)).toEqual(["notify"]);
  }, 60_000);

  it("a read-only bot can intentionally request attention", async () => {
    const botId = await newBot("Read-only monitor", "grokNotify");
    expect((await api("PATCH", `/api/bots/${botId}/access`, { access: "read-only" })).status).toBe(200);
    await api("POST", `/api/bots/${botId}/messages`, { text: "Check for a blocker" });
    await waitForReply(botId);
    await until(() => kinds(botId).includes("notify"), 1_000);
    expect(kinds(botId)).toContain("notify");
  }, 45_000);

  it("a member's reminder on a team bot notifies only that member over push, SSE and WebSocket", async () => {
    const botId = await newBot("Shared reminder bot", "happy");
    const streams: Array<{ frames: any[]; close: () => void }> = [];
    for (const token of [TOKEN, memberToken]) {
      const frames: any[] = [];
      const socket = new WebSocket(`${base.replace("https", "wss")}/api/events`, ["multibot-v2", token]);
      socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
      streams.push({ frames, close: () => socket.close() });
      await expect.poll(() => frames.some((f) => f.kind === "hello")).toBe(true);
      const abort = new AbortController();
      const response = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
      const sseFrames: any[] = [];
      streams.push({ frames: sseFrames, close: () => abort.abort() });
      void (async () => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (frame.startsWith("data: ")) sseFrames.push(JSON.parse(frame.slice(6)));
            }
          }
        } catch { /* aborted in cleanup */ }
      })();
    }
    try {
      const created = await api("POST", "/api/reminders", {
        botId, text: "Member appointment", at: new Date(Date.now() + 1_000).toISOString(),
      }, memberToken);
      expect(created.status).toBe(201);
      await expect.poll(() => kinds(botId)).toEqual(["reminder"]);
      expect(pushes.find((p) => p.data?.botId === botId)?.to).toBe("ExponentPushToken[member]");
      for (const { frames } of streams) {
        await expect.poll(() => frames.some((f) => f.kind === "workspace" && f.resource === "reminders" && f.botId === botId)).toBe(true);
      }
      for (const { frames } of streams.slice(2)) {
        await expect.poll(() => frames.filter((f) => f.kind === "notify" && f.botId === botId).length).toBe(1);
      }
      for (const { frames } of streams.slice(0, 2)) {
        expect(frames.filter((f) => f.kind === "notify" && f.botId === botId)).toEqual([]);
      }
    } finally {
      for (const stream of streams) stream.close();
    }
  }, 45_000);

  // multibot (K4): bot stoi na karcie i czeka — to JEST powód, żeby brzęknąć.
  // Raz: start tury ani jej koniec nie dokładają drugiego powiadomienia.
  it("pytanie do człowieka brzęczy telefon dokładnie raz, kanałem `asks`", async () => {
    const botId = await newBot("Pytacz", "grokAsk");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "zdecyduj coś" })).status).toBe(202);
    await until(() => kinds(botId).includes("question"), 30_000);
    // karta czeka na człowieka dłużej niż 8 s — gdyby start/koniec tury też
    // pushował, zdążyłby w tym oknie
    await until(() => false, 8_000);
    // `kinds` liczy WIADOMOŚCI, a jedno powiadomienie leci na każde zapisane
    // urządzenie — liczy się więc zbiór rodzajów, nie długość listy
    expect(new Set(kinds(botId))).toEqual(new Set(["question"]));
    const ask = pushes.find((p) => p.data?.botId === botId && p.data?.kind === "question");
    expect(ask?.title).toBe("Pytacz");
    expect(ask?.channelId).toBe("asks");
  }, 60_000);

  // multibot (K4): najważniejsza reguła tej fali — rutyna, która po cichu
  // zrobiła swoje, NIE budzi telefonu. Kończy się `finished`, a `finished`
  // nie przechodzi bramki.
  it("rutyna: cichy przebieg nie powiadamia", async () => {
    const botId = await newBot("Cicha rutyna", "happy");
    const routine = (await api("POST", `/api/bots/${botId}/routines`, {
      name: "raport", prompt: "zrób raport", schedule: "0 4 * * *",
    })).body;
    expect((await api("POST", `/api/bots/${botId}/routines/${routine.id}/run`)).status).toBe(200);
    // tura naprawdę poszła…
    await until(() => false, 15_000);
    const bot = await botState(botId);
    expect((bot?.messages ?? []).some((m: any) => m.role === "bot" && m.kind === "text" && m.text)).toBe(true);
    // …i telefon o niej nie usłyszał
    expect(kinds(botId)).toEqual([]);
  }, 70_000);

  // …ale rutyna, która o coś PYTA, brzęczy: wtedy praca stanęła na człowieku.
  it("rutyna, która pyta człowieka, brzęczy", async () => {
    const botId = await newBot("Pytająca rutyna", "grokAsk");
    const routine = (await api("POST", `/api/bots/${botId}/routines`, {
      name: "decyzja", prompt: "zapytaj o decyzję", schedule: "0 4 * * *",
    })).body;
    expect((await api("POST", `/api/bots/${botId}/routines/${routine.id}/run`)).status).toBe(200);
    await until(() => kinds(botId).includes("question"), 30_000);
    expect(new Set(kinds(botId))).toEqual(new Set(["question"]));
  }, 70_000);

  it("koniec tury użytkownika: cisza", async () => {
    const botId = await newBot("Szybki", "happy");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "cześć" })).status).toBe(202);
    // bot naprawdę odpowiedział…
    const deadline = Date.now() + 30_000;
    let said = false;
    while (!said && Date.now() < deadline) {
      const bot = await botState(botId);
      said = (bot?.messages ?? []).some((m: any) => m.role === "bot" && m.kind === "text" && m.text);
      if (!said) await new Promise((r) => setTimeout(r, 200));
    }
    expect(said).toBe(true);
    // …i nikomu przez to nie zabrzęczał telefon
    expect(kinds(botId)).toEqual([]);
  }, 60_000);

  it("tura bot-bot: żaden z botów nie pushuje", async () => {
    const helperId = await newBot("Pomocnik", "happy");
    const askerId = await newBot("Wolacz", "grokPeer");
    expect((await api("POST", `/api/bots/${askerId}/messages`, { text: "hey @Pomocnik ping" })).status).toBe(202);
    await until(() => false, 15_000);
    expect(kinds(helperId)).toEqual([]);
    expect(kinds(askerId)).toEqual([]);
  }, 60_000);

  it("wyłączony przełącznik bota ucisza nawet przypomnienie", async () => {
    const botId = await newBot("Cichy", "happy");
    await api("PATCH", `/api/bots/${botId}`, { notifications: false });
    const at = new Date(Date.now() + 2_000).toISOString();
    expect((await api("POST", "/api/reminders", { botId, text: "kawa", at })).status).toBe(201);
    await until(() => false, 15_000);
    expect(kinds(botId)).toEqual([]);
    // rekord sam w sobie odpalił — ucichł push, nie harmonogram
    const list = (await api("GET", `/api/bots/${botId}/reminders`)).body;
    expect(list[0].status).toBe("fired");
  }, 70_000);

  // multibot: przypomnienie to OSOBNY rekord (nie rutyna z datą ISO). Odpala
  // raz: push na telefon i pigułka `reminder` w transkrypcie bota.
  it("przypomnienie: push `reminder`, pigułka w czacie, i tylko RAZ", async () => {
    const botId = await newBot("Budzik", "happy");
    const reminder = await fireReminder(botId, "kawa");
    expect(reminder?.title).toBe("Budzik");
    expect(reminder?.body).toBe("kawa");
    // przypomnienie ma dożyć do rana, a nie wygasnąć po godzinie
    expect(reminder?.ttl).toBe(24 * 3600);
    // ładunek dostarczalny na Androidzie
    expect(reminder?.priority).toBe("high");
    // przypomnienia mają własny kanał Androida, żeby dało się je wyciszyć
    // osobno od próśb bota
    expect(reminder?.channelId).toBe("reminders");
    expect(reminder?.sound).toBe("default");
    expect(reminder?.data).toMatchObject({ botId, kind: "reminder" });

    // pigułka zdarzenia w wątku bota
    const deadline = Date.now() + 15_000;
    let pill: any;
    while (!pill && Date.now() < deadline) {
      const bot = await botState(botId);
      pill = (bot?.messages ?? []).find((m: any) => m.event?.type === "reminder");
      if (!pill) await new Promise((r) => setTimeout(r, 200));
    }
    expect(pill?.event).toMatchObject({ type: "reminder", value: "kawa" });

    // rekord zostaje jako odpalony i nie odpala drugi raz przez kolejny takt
    const list = (await api("GET", `/api/bots/${botId}/reminders`)).body;
    expect(list[0]).toMatchObject({ text: "kawa", status: "fired" });
    expect(list[0].firedAt).not.toBeNull();
    const before = kinds(botId).filter((k) => k === "reminder").length;
    await until(() => false, 10_000);
    expect(kinds(botId).filter((k) => k === "reminder").length).toBe(before);
  }, 120_000);

  it("przypomnienie w przeszłości: 422, bez martwego rekordu", async () => {
    const botId = await newBot("Spóźnialski", "happy");
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await api("POST", "/api/reminders", { botId, text: "wczoraj", at: past });
    expect(res.status).toBe(422);
    expect((await api("GET", `/api/bots/${botId}/reminders`)).body).toEqual([]);
  }, 40_000);

  it("drzemka przesuwa przypomnienie, kasowanie je usuwa", async () => {
    const botId = await newBot("Drzemiący", "happy");
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const created = (await api("POST", "/api/reminders", { botId, text: "spotkanie", at })).body;
    const snoozed = (await api("POST", `/api/reminders/${created.id}/snooze`, { minutes: 60 })).body;
    expect(Date.parse(snoozed.at)).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(snoozed.status).toBe("pending");
    expect((await api("DELETE", `/api/reminders/${created.id}`)).status).toBe(200);
    expect((await api("GET", `/api/bots/${botId}/reminders`)).body).toEqual([]);
  }, 40_000);

  // multibot: droga bota — „przypomnij mi o dentyście" kończy się REKORDEM
  // przypomnienia, nie rutyną z datą.
  it("create_reminder z tury bota zakłada przypomnienie i pigułkę w czacie", async () => {
    const botId = await newBot("Sekretarz", "grokReminder");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "przypomnij mi o dentyście" })).status).toBe(202);
    const deadline = Date.now() + 40_000;
    let list: any[] = [];
    while (list.length === 0 && Date.now() < deadline) {
      list = (await api("GET", `/api/bots/${botId}/reminders`)).body ?? [];
      if (list.length === 0) await new Promise((r) => setTimeout(r, 300));
    }
    expect(list[0]).toMatchObject({ text: "dentysta", botId, status: "pending" });
    // rekord przypomnienia, NIE rutyna — rutyny bota mają zostać puste
    expect((await api("GET", `/api/bots/${botId}/routines`)).body).toEqual([]);
    // pigułka „ustawiłem przypomnienie" w transkrypcie
    const bot = await botState(botId);
    expect((bot?.messages ?? []).some((m: any) => m.event?.type === "reminder-created" && m.event.value === "dentysta")).toBe(true);
  }, 70_000);

  // multibot: `notify_user` — jedyny push, o który prosi sam bot.
  it("notify_user: push z powodem i bot oznaczony jako nieprzeczytany", async () => {
    const botId = await newBot("Krzykacz", "grokNotify");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "zrób raport" })).status).toBe(202);
    await until(() => kinds(botId).includes("notify"), 30_000);
    const notification = pushes.find((p) => p.data?.botId === botId && p.data?.kind === "notify");
    expect(notification?.title).toBe("Krzykacz");
    // „<bot> chce czegoś od Ciebie: <powód>" — nazwa bota jest tytułem pusha
    expect(notification?.body).toContain("Zebrałem dane z wczoraj.");
    expect(notification?.body.toLowerCase()).toMatch(/wants something from you|chce czegoś od ciebie/);
    expect((await botState(botId))?.unread).toBe(true);
  }, 60_000);

  it("request_connection: karta `connect` w czacie, tura kończy się bez czekania", async () => {
    const botId = await newBot("Prosiciel", "grokConnect");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "wyślij maila" })).status).toBe(202);
    const deadline = Date.now() + 30_000;
    let card: any;
    while (!card && Date.now() < deadline) {
      const bot = await botState(botId);
      card = (bot?.messages ?? []).find((m: any) => m.card?.kind === "connect");
      if (!card) await new Promise((r) => setTimeout(r, 200));
    }
    expect(card?.card).toMatchObject({ kind: "connect", connector: "google-workspace" });
    expect(card.card.subtitle).toBe("Muszę wysłać maila.");
    await until(() => kinds(botId).includes("finished"), 30_000);
    expect((await botState(botId))?.busy).not.toBe(true);
  }, 60_000);

  // multibot: bot prosił o `discord` i dostawał „did not recognize the
  // connector name". Każdy slug toolkitu Composio (discord, slack, gmail…) ma
  // prowadzić do karty Composio z nazwą aplikacji, a nie do odmowy.
  it("request_connection: nazwa aplikacji (discord) daje kartę Composio", async () => {
    const botId = await newBot("Discordowiec", "grokConnectApp");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "napisz na discordzie" })).status).toBe(202);
    const deadline = Date.now() + 30_000;
    let card: any;
    while (!card && Date.now() < deadline) {
      const bot = await botState(botId);
      card = (bot?.messages ?? []).find((m: any) => m.card?.kind === "connect");
      if (!card) await new Promise((r) => setTimeout(r, 200));
    }
    expect(card?.card).toMatchObject({ kind: "connect", connector: "composio" });
    expect(card.card.title).toContain("Discord");
  }, 60_000);

  it("ticket `DeviceNotRegistered` kasuje urządzenie z configu", async () => {
    expect((await api("POST", "/api/devices/dead-phone/push", { token: DEAD_TOKEN })).status).toBe(200);
    expect(pushDevices()["dead-phone"]).toBeDefined();
    const botId = await newBot("Sprzątacz", "happy");
    // trzeba czegoś, co NAPRAWDĘ leci na telefon — po zawężeniu bramki
    // zwykła tura już nie wystarcza
    await fireReminder(botId, "sprzątanie");
    await until(() => pushDevices()["dead-phone"] === undefined);
    expect(pushDevices()["dead-phone"]).toBeUndefined();
    // żywe urządzenie zostaje — kasujemy tylko to, które Expo odrzuciło
    expect(pushDevices()["test-phone"]).toBeDefined();
  }, 90_000);
});
