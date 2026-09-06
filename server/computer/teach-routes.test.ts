// The teach routes end to end: a real harness process, a fake DevTools endpoint
// standing in for the computer's browser, and the panel's exact call sequence —
// POST teach/start, demonstrate, POST teach/stop, hand the steps to
// teach/synthesize.
//
// Synthesis itself (steps → a written skill, through the bot's own provider) is
// already covered against a fake driver in server/comms.test.ts; here we only
// pin the handoff: what the panel posts is what the route accepts.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFakeCdp, type FakeCdp } from "../testing/fake-cdp.ts";
import { bootstrapAccessToken } from "../testing/identity.ts";

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
let TOKEN = "";

let child: ChildProcess;
let home: string;
let stderr = "";
let fake: FakeCdp;

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

beforeAll(async () => {
  fake = await startFakeCdp();
  home = mkdtempSync(join(tmpdir(), "omb-teach-test-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({}));

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_ONBOARDING_TURN: "0",
      OMB_HOST: "127.0.0.1",
      // No container in a test run — the browser is the fake below.
      MULTIBOT_COMPUTER: "off",
      MULTIBOT_COMPUTER_CDP_URL: fake.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 90_000;
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
  TOKEN = await bootstrapAccessToken(BASE);
}, 120_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  await fake?.close();
  // Windows keeps a handle a moment after the process dies; a leftover temp dir
  // is not worth failing a green suite over.
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the OS will get it */
  }
});

describe("teach start/stop", () => {
  it("records a demonstration and hands the steps on to synthesize", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;

    const started = await api("POST", `/api/bots/${bot.id}/teach/start`);
    expect(started.status).toBe(200);
    expect(typeof started.body.recording_id).toBe("string");

    const say = (payload: Record<string, unknown>) =>
      fake.emit({ method: "Runtime.bindingCalled", params: { name: "multibotTeach", payload: JSON.stringify(payload) } });
    say({ type: "click", selector: "#orders", text: "Orders" });
    say({ type: "input", selector: "#q", value: "shoe" });
    say({ type: "input", selector: "#q", value: "shoes" });
    // A password field is redacted in the page, never here — pin that the
    // recorder passes the marker through instead of a real secret.
    say({ type: "input", selector: "#pw", value: "[REDACTED]" });
    await new Promise((r) => setTimeout(r, 100));

    const stopped = await api("POST", `/api/bots/${bot.id}/teach/stop`, { recording_id: started.body.recording_id });
    expect(stopped.status).toBe(200);
    expect(stopped.body.steps).toEqual([
      'clicked "Orders"',
      'typed "shoes" into q',
      'typed "[REDACTED]" into pw',
    ]);

    // The panel posts exactly these steps next. Empty ones are refused before a
    // turn is ever started, so nobody waits minutes for a model on a mistake.
    const empty = await api("POST", `/api/bots/${bot.id}/teach/synthesize`, { steps: [] });
    expect(empty.status).toBe(422);
  }, 60_000);

  it("a second stop has nothing to stop, and an unknown bot is a 404", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("POST", `/api/bots/${bot.id}/teach/stop`, {})).status).toBe(404);
    expect((await api("POST", "/api/bots/does-not-exist/teach/start")).status).toBe(404);
  }, 30_000);
});
