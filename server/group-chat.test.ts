// multibot: grupa jako zwykły czat. Jedna wiadomość idzie do członków PO
// KOLEI, każdy widzi, co powiedzieli poprzednicy, i sam decyduje: odpowiada,
// przekazuje po @nazwie albo milczy ([NO REPLY]). Test chodzi po prawdziwym
// harnessie z fake'owym ACP w trybie `script` (odpowiedź wybierana po treści
// promptu, więc nie zależy od kolejności tur).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrapAccessToken } from "./testing/identity.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");

const scripted = (script: unknown) => ({
  driver: "grokAgent",
  environment: { FAKE_ACP_MODE: "script", FAKE_ACP_SCRIPT: JSON.stringify(script) },
  config: { cli: FAKE_CLI, fullAuto: true },
});

/** Atlas: ogólny, przekazuje research dalej i milczy, gdy kolega już odpisał. */
const ATLAS = scripted({
  default: "hello from Atlas",
  rules: [
    { match: "RESEARCH-DONE", text: "[NO REPLY]" },
    { match: "NEED-RESEARCH", text: "that is a job for @Researcher" },
  ],
});
/** Researcher: odpowiada tylko na to, co dotyczy researchu. */
const RESEARCH = scripted({
  default: "hello from Researcher",
  rules: [
    { match: "job for @Researcher", text: "RESEARCH-DONE: three sources, all agree." },
    { match: "MENTION-ONLY", text: "Researcher answering the mention." },
  ],
});

let child: ChildProcess;
let base = "";
let token = "";
let home = "";
let stderr = "";

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const bots = async () => (await api("GET", "/api/bots")).body.bots as any[];
const botOf = async (id: string) => (await bots()).find((b) => b.id === id);
const roomOf = async (id: string) => (await api("GET", `/api/rooms/${id}`)).body;

const newBot = async (name: string, instanceId: string, description: string) => {
  const created = (await api("POST", "/api/bots")).body.bot;
  await api("PATCH", `/api/bots/${created.id}`, {
    name,
    description,
    modelSelection: { instanceId, model: "fake-model" },
  });
  return created.id as string;
};

const newGroup = async (name: string, botIds: string[]) =>
  (await api("POST", "/api/groups", { name, bot_ids: botIds })).body.id as string;

/** Prawdziwy harness na losowym porcie; `extraEnv` decyduje o silniku. */
const startHarness = async (extraEnv: Record<string, string>) => {
  chmodSync(FAKE_CLI, 0o755);
  const port = 18800 + Math.floor(Math.random() * 10_000);
  base = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "omb-groupchat-"));
  stderr = "";
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({ instances: { atlas: ATLAS, research: RESEARCH } }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_HOST: "127.0.0.1",
      MULTIBOT_COMPUTER: "off",
      OMB_ONBOARDING_TURN: "0",
      OMB_TURN_DEBOUNCE_MS: "150",
      ...extraEnv,
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
    await new Promise((r) => setTimeout(r, 150));
  }
  token = await bootstrapAccessToken(base);
};

const stopHarness = async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  if (process.platform === "win32") await new Promise((r) => setTimeout(r, 750));
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error;
  }
};

describe("group chat: the user writes to everyone, the members pick who answers", () => {
  let atlas = "";
  let researcher = "";

  beforeAll(async () => {
    await startHarness({});
    for (const seeded of await bots()) await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    atlas = await newBot("Atlas", "atlas", "chief of staff, general questions and coordination");
    researcher = await newBot("Researcher", "research", "web research, sources, fact checking");
  }, 40_000);

  afterAll(stopHarness);

  it("na powitanie odpisuje KAŻDY członek, a w prywatnym czacie zostaje ślad", async () => {
    const gid = await newGroup("Ekipa", [atlas, researcher]);
    const chat = await api("POST", `/api/groups/${gid}/chat`, { message: "hej" });
    expect(chat.status).toBe(200);
    expect(typeof chat.body.roomId).toBe("string");

    const room = await roomOf(chat.body.roomId);
    expect(room.groupId).toBe(gid);
    // wiadomość użytkownika jest w transkrypcie pokoju jako `from: "user"`
    expect(room.transcript[0]).toMatchObject({ from: "user", text: "hej" });
    const said = (id: string) => room.transcript.filter((m: any) => m.from === id).map((m: any) => m.text);
    expect(said(atlas)).toEqual(["hello from Atlas"]);
    expect(said(researcher)).toEqual(["hello from Researcher"]);

    // ślad w prywatnych czatach obu członków: klikalny czip pokoju grupy
    for (const id of [atlas, researcher]) {
      const bot = await botOf(id);
      const chip = bot.messages.find((m: any) => m.kind === "room" && m.room?.id === room.id);
      expect(chip, `brak czipa grupy w czacie ${id}`).toBeTruthy();
    }
  }, 90_000);

  it("zadanie pod opis kolegi: Atlas przekazuje @Researcher, ten odpowiada, Atlas milczy", async () => {
    const gid = await newGroup("Robota", [atlas, researcher]);
    const chat = await api("POST", `/api/groups/${gid}/chat`, { message: "NEED-RESEARCH: check the sources" });
    expect(chat.status).toBe(200);

    const roomId = chat.body.roomId as string;
    // odpowiedź Researchera wraca przez dostarczanie peer-to-peer, więc pokój
    // domyka się chwilę po odpowiedzi HTTP
    const deadline = Date.now() + 40_000;
    let room = await roomOf(roomId);
    while (!room.transcript.some((m: any) => m.from === researcher) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      room = await roomOf(roomId);
    }
    const said = (id: string) => room.transcript.filter((m: any) => m.from === id).map((m: any) => m.text);
    expect(said(atlas)).toEqual(["that is a job for @Researcher"]);
    expect(said(researcher)[0]).toContain("RESEARCH-DONE");
    // druga tura Atlasa to [NO REPLY] — cisza, więc ani w pokoju, ani w wątku
    expect(JSON.stringify(room.transcript)).not.toContain("[NO REPLY]");
    const atlasBot = await botOf(atlas);
    expect(atlasBot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("[NO REPLY]"))).toEqual([]);
  }, 90_000);

  it("@wzmianka zawęża dostarczenie do wymienionych członków", async () => {
    const gid = await newGroup("Wzmianka", [atlas, researcher]);
    const chat = await api("POST", `/api/groups/${gid}/chat`, { message: "@Researcher MENTION-ONLY please" });
    expect(chat.status).toBe(200);
    expect(chat.body.turns.map((t: any) => t.bot_id)).toEqual([researcher]);

    const room = await roomOf(chat.body.roomId);
    expect(room.transcript.some((m: any) => m.from === researcher)).toBe(true);
    expect(room.transcript.some((m: any) => m.from === atlas)).toBe(false);
  }, 90_000);
});
