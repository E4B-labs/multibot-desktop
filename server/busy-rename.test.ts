// Reproduces the two reported busy regressions through the real HTTP API:
//   #2 the stop button vanishes after a rename (busy lost on rename broadcast)
//   #3 the stop button lags (busy not cleared promptly on interrupt)
// A fake ACP instance (hang mode) keeps a turn running so busy stays true
// across the rename, letting us assert it is preserved.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let home: string;
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

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      port = (probe.address() as { port: number }).port;
      probe.close((error) => error ? reject(error) : resolve());
    });
  });
  base = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "omb-busy-test-"));
  mkdirSafe(join(home, ".openmausbot"));
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      instances: { fake: { driver: "grokAgent", displayName: "Fake", config: { cli: FAKE_CLI, fullAuto: false } } },
    }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_ONBOARDING_TURN: "0",
      MULTIBOT_COMPUTER: "off",
      OMB_HOST: "127.0.0.1",
      // ten test pilnuje `busy` w trakcie tury, nie okna sklejania wiadomości
      OMB_TURN_DEBOUNCE_MS: "0",
      FAKE_ACP_MODE: "hang",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
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
  // The hanging fake CLI is a grandchild; give the OS a moment to release
  // its handles in the temp home before we blow it away.
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(home, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

function mkdirSafe(p: string) {
  try {
    require("node:fs").mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
}

type Frame = { kind: string; [k: string]: any };

const openSse = async (): Promise<{ frames: Frame[]; close: () => void }> => {
  const frames: Frame[] = [];
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let closed = false;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || closed) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              frames.push(JSON.parse(line.slice(6)));
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  })();
  return {
    frames,
    close: () => {
      closed = true;
      reader.cancel().catch(() => {});
    },
  };
};

describe("busy across rename and interrupt", () => {
  it("keeps busy:true through a rename (live SSE) and clears it on interrupt", async () => {
    const sse = await openSse();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const id = created.body.bot.id;

    // Start a turn — fake CLI hangs, so busy must stay true. Wiadomość
    // przechodzi przez kolejkę tur, więc `busy` zapala się o tik później.
    const sent = await api("POST", `/api/bots/${id}/messages`, { text: "work" });
    expect(sent.status).toBe(202);
    let running = await getBot(id);
    for (let i = 0; i < 40 && !running.busy; i++) {
      await wait(50);
      running = await getBot(id);
    }
    expect(running.busy).toBe(true);

    // Rename while busy — the regression: busy lost, stop button vanishes.
    const renamed = await api("PATCH", `/api/bots/${id}`, { name: "Renamed" });
    expect(renamed.status).toBe(200);
    const afterRename = await getBot(id);
    expect(afterRename.name).toBe("Renamed");
    expect(afterRename.busy).toBe(true);

    // The live SSE broadcast must carry busy:true to the client.
    await wait(150);
    const liveBusy = sse.frames.find(
      (f) => f.kind === "bot" && f.bot?.id === id && f.bot.busy === true && f.bot.name === "Renamed",
    );
    expect(liveBusy, `no live busy:true bot frame for rename. seen: ${JSON.stringify(sse.frames.filter((f) => f.kind === "bot"))}`).toBeTruthy();

    // Interrupt — busy must clear promptly so the stop button hides.
    const stopped = await api("POST", `/api/bots/${id}/interrupt`);
    expect(stopped.status).toBe(200);
    const afterStop = await getBot(id);
    expect(afterStop.busy).toBe(false);

    await wait(150);
    const liveStop = sse.frames.find((f) => f.kind === "bot" && f.bot?.id === id && f.bot.busy === false);
    expect(liveStop, `no live busy:false bot frame after interrupt. seen: ${JSON.stringify(sse.frames.filter((f) => f.kind === "bot"))}`).toBeTruthy();

    sse.close();
  });
});
