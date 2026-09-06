// Collaboration rooms, end to end: boots the real harness server with the
// grokAgent driver pointed at the fake ACP CLI in "room" mode (the first turn
// contributes plain work, the second ends with [TASK COMPLETE]).
// Exercises: POST /api/rooms hands the task to the peer as a real turn → the
// answers land in the room ledger → the marker settles it to "done" and the
// originator's chat holds both the clickable "X texted Y" chip and the report;
// plus the user-@mention trigger, which opens the same kind of room.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapAccessToken } from "./testing/identity.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `https://127.0.0.1:${PORT}`;
let TOKEN = "";

let child: ChildProcess;
let home: string;
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

const waitFor = async (fn: () => Promise<boolean>, ms = 20_000, what = "condition") => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr:\n${stderr.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

beforeAll(async () => {
  chmodSync(FAKE_CLI, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-rooms-test-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
        instances: {
          grok: {
            driver: "grokAgent",
            // multibot: licznik w pliku, bo każda tura to osobny proces —
            // pierwsza wkładka bez markera, druga domyka pokój, więc rozmowa
            // ma pełną wymianę w obie strony, nie jedną odpowiedź.
            environment: { FAKE_ACP_MODE: "room", FAKE_ACP_ROOM_COUNTER: join(home, "room-counter.txt") },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokBusy: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "busy" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokRoom2: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "room", FAKE_ACP_ROOM_COUNTER: join(home, "room-counter-2.txt") },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // multibot: licznik startuje z 1, więc KAŻDA tura kończy się markerem
          // — atrapa bota, który po pierwszej wkładce ogłasza "gotowe".
          grokRoomDone: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "room", FAKE_ACP_ROOM_COUNTER: join(home, "room-counter-done.txt") },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
    }),
  );
  writeFileSync(join(home, "room-counter-done.txt"), "1");

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
  TOKEN = await bootstrapAccessToken(BASE, home);
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

describe("collaboration rooms", () => {
  // idki z pierwszego pokoju — drugi test liczy pokoje tej pary botów
  let pairA = "";
  let pairB = "";

  it("seals /api/rooms behind the boot token", async () => {
    const res = await fetch(`${BASE}/api/rooms`);
    expect(res.status).toBe(401);
  });

  it(
    "hands the task over as a real turn, settles on the marker, and reports back to the originator",
    async () => {
      const selection = { instanceId: "grok", model: "fake-model" };
      const a = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${a.id}`, { name: "Room A", modelSelection: selection });
      const b = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${b.id}`, { name: "Room B", modelSelection: selection });
      pairA = a.id;
      pairB = b.id;

      const created = await api("POST", "/api/rooms", { task: "write a report together", bot_ids: [a.id, b.id] });
      expect(created.status).toBe(201);
      const roomId = created.body.id;

      await waitFor(async () => (await api("GET", `/api/rooms/${roomId}`)).body?.status === "done", 40_000, "room done");

      const room = (await api("GET", `/api/rooms/${roomId}`)).body;
      // the ledger opens with the originator's task, then the answers
      expect(room.transcript[0]).toMatchObject({ from: a.id, text: "write a report together" });
      expect(room.transcript.some((m: any) => m.from === b.id && m.text.includes("room work from fake"))).toBe(true);
      // the done marker never shows up in the visible transcript
      expect(JSON.stringify(room.transcript)).not.toContain("TASK COMPLETE");
      // the peer read the task in its PROMPT: the fake only says "peer seen"
      // when the incoming text reached it, and only a real turn carries it
      expect(room.transcript.some((m: any) => m.text.startsWith("peer seen"))).toBe(true);

      // the originator's 1:1 chat carries the clickable chip and the report
      const aBot = await getBot(a.id);
      const chip = aBot.messages.find((m: any) => m.kind === "room" && m.room?.id === roomId);
      expect(chip).toBeTruthy();
      expect(chip.room.ownerBotId).toBe(a.id);
      expect(chip.room.bot_ids).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(aBot.messages.some((m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("finished (done)"))).toBe(true);
    },
    60_000,
  );

  it("a conversation never nests rooms: the whole exchange stays one RoomRecord", async () => {
    // Kolejne wiadomości tej pary trafiają do ISTNIEJĄCEGO pokoju (reuse w
    // deliverPeerMessage) — gdyby każda otwierała własny, budżet nie miałby
    // czego liczyć i użytkownik dostawałby pigułkę za pigułką.
    const all = (await api("GET", "/api/rooms")).body.rooms;
    expect(all.filter((r: any) => r.bot_ids.includes(pairA) && r.bot_ids.includes(pairB))).toHaveLength(1);
  });

  // multibot: produkcja (pokój Repo Auditor / PR Reviewer, 0.3.27) kończyła się
  // na wkładce pierwszego bota — ten kończył ją markerem [TASK COMPLETE], a
  // runCollab wychodziło z pętli, zanim kolega w ogóle dostał turę. Marker z
  // PIERWSZEJ rundy ma domykać pokój dopiero po pełnej rundzie.
  it(
    "a done marker in the first round still lets every participant take a turn",
    async () => {
      const selection = { instanceId: "grokRoomDone", model: "fake-model" };
      const a = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${a.id}`, { name: "Done A", modelSelection: selection });
      const b = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${b.id}`, { name: "Done B", modelSelection: selection });

      const created = await api("POST", "/api/rooms", { task: "close it fast", bot_ids: [a.id, b.id] });
      expect(created.status).toBe(201);
      const roomId = created.body.id;

      await waitFor(async () => (await api("GET", `/api/rooms/${roomId}`)).body?.status === "done", 25_000, "room done");
      const room = (await api("GET", `/api/rooms/${roomId}`)).body;
      const authors = new Set(room.transcript.map((m: any) => m.from));
      expect([...authors].sort()).toEqual([a.id, b.id].sort());
    },
    40_000,
  );


  it(
    "opens a room when the user @mentions another bot, strips the tag, and hands the task over as a turn",
    async () => {
      const selection = { instanceId: "grok", model: "fake-model" };
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker Room", modelSelection: selection });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper Room", modelSelection: selection });

      // Odpowiedź HTTP nie czeka na rozmowę — wolno jej trwać godzinami, więc
      // czekanie tutaj wieszało czat.
      const startedAt = Date.now();
      const sent = await api("POST", `/api/bots/${asker.id}/messages`, { text: "zrób raport @Helper Room" });
      expect(sent.status).toBe(202);
      expect(Date.now() - startedAt).toBeLessThan(3_000);

      // the mention spawned a room whose task has the tag stripped
      await waitFor(async () => {
        const { body } = await api("GET", "/api/rooms");
        return body.rooms?.some((r: any) => r.ownerBotId === asker.id);
      }, 25_000, "mention room");

      const { body } = await api("GET", "/api/rooms");
      const room = body.rooms.find((r: any) => r.ownerBotId === asker.id);
      expect(room.task).toBe("zrób raport");
      expect(room.task).not.toContain("@");

      // the tagged peer answers in the room, on its own turn
      await waitFor(async () => {
        const { body: live } = await api("GET", "/api/rooms");
        const current = live.rooms.find((r: any) => r.id === room.id);
        return (current?.transcript ?? []).some((m: any) => m.from === helper.id && m.text?.includes("room work from fake"));
      }, 30_000, "the peer's answer in the room");

      // Bańka użytkownika zostaje tym, co napisał — pokój ma własny klikalny
      // widok, więc transkrypt nie wchodzi do czatu.
      const askerBot = await getBot(asker.id);
      const mine = askerBot.messages.filter((m: any) => m.role === "user" && m.kind === "text");
      expect(mine[0].text).toBe("zrób raport @Helper Room");
      expect(mine.some((m: any) => m.text?.includes("room work from fake"))).toBe(false);
    },
    40_000,
  );
});
