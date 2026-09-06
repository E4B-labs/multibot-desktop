// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. A deliberately-unknown overlay pins shadow-instance
// behavior without replacing the built-in fleet.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `https://127.0.0.1:${PORT}`;
// Real identity v2 credential, minted in beforeAll by actually setting the
// server up and registering its first (owner) profile.
let TOKEN = "";
let serverName = "";
let serverPassword = "";
let setupAddress = "";
let setupFingerprint: string | null = null;
let setupValuesBehindProxy = 0;
let setupValuesWithoutToken = 0;

let child: ChildProcess;
let home: string;
let stderr = "";
let staticDir: string;
// Stand-in for OpenAI speech, same trick as MULTIBOT_EXPO_PUSH_URL in push.ts:
// the route is real, only the upstream is local. Records what it was asked for
// so the test can assert the key and the text actually travelled.
let ttsServer: Server;
let ttsRequests: Array<{ authorization?: string; body: any }> = [];
const TTS_AUDIO = Buffer.from("ID3-fake-mp3-bytes");

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-multibot-protocol": "2",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  ttsServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      ttsRequests.push({ authorization: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(TTS_AUDIO.length) });
      res.end(TTS_AUDIO);
    });
  });
  await new Promise<void>((resolve) => ttsServer.listen(0, "127.0.0.1", resolve));
  const ttsUrl = `http://127.0.0.1:${(ttsServer.address() as { port: number }).port}/v1/audio/speech`;

  home = mkdtempSync(join(tmpdir(), "omb-api-test-"));
  staticDir = join(home, "dist");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Multibot login</title>");
  writeFileSync(join(staticDir, "app.js"), "console.log('login shell')");
  writeFileSync(join(staticDir, "manifest.webmanifest"), JSON.stringify({ name: "Multibot", start_url: "/" }));
  writeFileSync(join(staticDir, "sw.js"), "self.addEventListener('fetch', () => {})");
  mkdirSync(join(staticDir, "assets"));
  writeFileSync(join(staticDir, "assets", "app-abc123.js"), "console.log('fingerprinted')");
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      voice: { key: "tts-test-key" },
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    }),
  );
  // Seed a terminal setup job so progress endpoint is covered without
  // launching real provisioning or package installation in this test.
  writeFileSync(
    join(home, ".openmausbot", "setup-jobs.json"),
    JSON.stringify([
      {
        id: "done-job",
        key: "test",
        kind: "provision",
        title: "Install bot server",
        command: "test-only",
        status: "succeeded",
        output: ["browser ready"],
        createdAt: 1,
        finishedAt: 2,
        exitCode: 0,
      },
    ]),
  );
  writeFileSync(
    join(home, ".openmausbot", "groups.json"),
    JSON.stringify([{ id: "g-local", name: "1", bot_ids: [], createdAt: 1, messages: [] }]),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
        OMB_ONBOARDING_TURN: "0",
      // multibot (H2): a spawned harness gets a minimal env, so VITEST does not
      // reach it — without this the server would provision REAL containers for
      // every throwaway test bot.
      MULTIBOT_COMPUTER: "off",
      // Loopback keeps tests valid in restricted CI sandboxes; public access
      // is provided by the HTTPS tunnel/reverse proxy in real deployments.
      OMB_HOST: "127.0.0.1",
      OMB_STATIC_DIR: staticDir,
      MULTIBOT_TTS_URL: ttsUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  // Boot probes every CLI provider before it listens; measured at ~39s on a
  // Windows dev box, so the old 20s cap skipped this whole suite there.
  const deadline = Date.now() + 90_000;
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

  // Bootstrap for real: the server configured itself on boot, so the suite
  // reads the three values back over loopback and registers the first profile —
  // exactly what a fresh install does. The returned access token is the only
  // credential every test below uses.
  // The proxy check belongs here: `/api/setup/values` stops answering the
  // moment a profile exists, so no later `it` could observe this state.
  // The setup token lives in the server's own setup.json — reading that file is
  // the actual permission, because loopback is not per-app on a phone.
  const setupToken = (JSON.parse(readFileSync(join(home, ".openmausbot", "setup.json"), "utf8")) as { setupToken: string }).setupToken;
  const withToken = { "x-multibot-setup": setupToken };
  setupValuesBehindProxy = (await fetch(`${BASE}/api/setup/values`, { headers: { ...withToken, "x-forwarded-for": "1.2.3.4" } })).status;
  setupValuesWithoutToken = (await fetch(`${BASE}/api/setup/values`)).status;
  const setup = await fetch(`${BASE}/api/setup/values`, { headers: withToken });
  if (setup.status !== 200) throw new Error(`setup values unavailable (${setup.status}): ${await setup.text()}`);
  const values = await setup.json() as { serverName: string; serverPassword: string; address: string; addresses: string[]; tlsFingerprint: string | null };
  serverName = values.serverName;
  serverPassword = values.serverPassword;
  setupAddress = values.address;
  setupFingerprint = values.tlsFingerprint;
  const registered = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "index-tester",
      password: "index-test-profile-password",
      displayName: "Index Tester",
      serverName,
      serverPassword,
      deviceName: "vitest",
    }),
  });
  if (registered.status !== 201) throw new Error(`owner registration failed (${registered.status}): ${await registered.text()}`);
  TOKEN = (await registered.json() as { accessToken: string }).accessToken;
  if (!TOKEN) throw new Error("registration returned no access token");
}, 120_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  await new Promise<void>((resolve) => ttsServer.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

describe("harness HTTP API", () => {
  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("multibot");
    expect(typeof body.pid).toBe("number");
    expect(body.static).toBe(true);
    expect(body.service).toBe(false);
  });

  it("serves the login shell on the same remote origin but protects every non-static route", async () => {
    const page = await fetch(`${BASE}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Multibot login");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${BASE}/app.js`)).status).toBe(200);
    expect((await fetch(`${BASE}/api/bots`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/auth/check`)).status).toBe(401);
    // Exact POST webhook is public; the HMAC over the routine secret is its
    // gate. An unknown id is a 404 from the webhook handler, not auth's 401.
    expect((await fetch(`${BASE}/webhooks/routine-id`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${BASE}/webhooks/routine-id`)).status).toBe(401);
    expect((await fetch(`${BASE}/webhooks/routine-id/extra`, { method: "POST" })).status).toBe(401);
    // Zepsuty escape w id: `decodeURIComponent` rzuca, a ta trasa siedzi przed
    // bramką auth i nie ma nad sobą nikogo, kto by wyjątek złapał — bez guardu
    // proces padał. Serwer ma odpowiedzieć i ŻYĆ dalej.
    expect((await fetch(`${BASE}/webhooks/%zz`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${BASE}/api/auth/check`)).status).toBe(401);
  });

  it("serves installable PWA files with update-safe MIME and cache headers", async () => {
    const manifest = await fetch(`${BASE}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(manifest.headers.get("cache-control")).toBe("no-cache");

    const worker = await fetch(`${BASE}/sw.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toBe("text/javascript");
    expect(worker.headers.get("cache-control")).toBe("no-cache");
    expect(worker.headers.get("service-worker-allowed")).toBe("/");

    const asset = await fetch(`${BASE}/assets/app-abc123.js`);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const head = await fetch(`${BASE}/manifest.webmanifest`, { method: "HEAD" });
    expect(await head.text()).toBe("");
  });

  it("keeps API data authenticated, JSON, and out of caches", async () => {
    const unauthorized = await fetch(`${BASE}/api/bots`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    expect(unauthorized.headers.get("content-type")).toBe("application/json");

    const authorized = await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("cache-control")).toBe("no-store");
    expect(authorized.headers.get("content-type")).toBe("application/json");
    expect((await authorized.json() as { bots: unknown[] }).bots).toBeDefined();
  });

  // Voice used to be engine-only, so a host without Hermes could not speak at
  // all. With a ttsKey the harness does it for every bot.
  it("speaks a message through the harness text-to-speech key", async () => {
    expect((await api("GET", "/api/config")).body.voice).toEqual({ configured: true });

    const bot = (await api("GET", "/api/bots")).body.bots[0];
    ttsRequests = [];
    const res = await fetch(`${BASE}/api/bots/${bot.id}/speak`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello there" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(TTS_AUDIO);
    expect(ttsRequests).toHaveLength(1);
    expect(ttsRequests[0].authorization).toBe("Bearer tts-test-key");
    expect(ttsRequests[0].body.input).toBe("hello there");

    expect((await api("POST", `/api/bots/${bot.id}/speak`, { text: "" })).status).toBe(422);
    expect((await api("POST", "/api/bots/no-such-bot/speak", { text: "hi" })).status).toBe(404);
  });

  it("seeds one starter bot with its greeting", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.length).toBeGreaterThanOrEqual(1);
    expect(body.bots[0].messages.length).toBeGreaterThanOrEqual(2);
  });

  it("stores driver-neutral routines for a harness bot", async () => {
    const bots = await api("GET", "/api/bots");
    const bot = bots.body.bots[0];
    const created = await api("POST", `/api/bots/${bot.id}/routines`, {
      name: "CLI digest",
      prompt: "Summarize today's work",
      schedule: "every 1h",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      botId: bot.id,
      name: "CLI digest",
      schedule: "every 1h",
      trigger: null,
      execution: { limitations: expect.any(Array) },
    });

    const id = created.body.id;
    expect((await api("GET", `/api/bots/${bot.id}/routines`)).body).toHaveLength(1);
    expect((await api("PATCH", `/api/bots/${bot.id}/routines/${id}`, { enabled: false })).body.enabled).toBe(false);
    // multibot (webhook): rutyny CLI mają teraz trigger webhooka — sekret
    // oddany raz przy włączeniu, re-enable go nie rotuje.
    const enabled = await api("POST", `/api/bots/${bot.id}/routines/${id}/webhook`);
    expect(enabled.status).toBe(200);
    expect(enabled.body.secret).toHaveLength(64);
    expect(enabled.body.url).toContain(`/webhooks/${id}`);
    const reEnabled = await api("POST", `/api/bots/${bot.id}/routines/${id}/webhook`);
    expect(reEnabled.body.secret).toBe(enabled.body.secret);
    // sekret nie wycieka do list() — trigger niesie tylko url/events
    const listed = (await api("GET", `/api/bots/${bot.id}/routines`)).body[0];
    expect(listed.trigger).toEqual({ type: "webhook", events: [], url: enabled.body.url });
    expect(listed.webhookSecret).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(enabled.body.secret);
    expect((await api("POST", `/api/bots/${bot.id}/routines`, {
      name: "Bad", prompt: "Nope", schedule: "61 * * * *",
    })).status).toBe(422);
    expect((await api("DELETE", `/api/bots/${bot.id}/routines/${id}`)).status).toBe(200);
    expect((await api("GET", `/api/bots/${bot.id}/routines`)).body).toEqual([]);
  });

  it("deletes the local group roster when engine is unavailable", async () => {
    expect((await api("GET", "/api/groups")).body.map((group: { id: string }) => group.id)).toContain("g-local");
    const deleted = await api("DELETE", "/api/groups/g-local");
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect((await api("GET", "/api/groups")).body).toEqual([]);
  });

  it("serves a provider-neutral workspace for every harness bot", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;

    const fact = await api("POST", `/api/bots/${bot.id}/memory/facts`, {
      text: "Prefers local models",
      source: "user",
    });
    expect(fact.status).toBe(201);
    expect((await api("GET", `/api/bots/${bot.id}/memory/facts`)).body).toEqual([fact.body]);
    expect((await api("PATCH", `/api/bots/${bot.id}/memory/facts/${fact.body.id}`, { text: "Prefers private models" })).body.text).toBe("Prefers private models");

    expect((await api("PUT", `/api/bots/${bot.id}/memory/markdown`, { content: "# Notes" })).body).toEqual({ content: "# Notes" });
    expect((await api("GET", `/api/bots/${bot.id}/memory/markdown`)).body).toEqual({ content: "# Notes" });

    const skill = await api("POST", `/api/bots/${bot.id}/skills`, {
      name: "review",
      description: "Review code",
      instructions: "Run tests.",
    });
    expect(skill.status).toBe(201);
    // multibot: skill z panelu zostawia w transkrypcie tę samą pigułkę co skill
    // napisany narzędziem bota — bez tego powstawał niewidocznie.
    const withSkill = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(
      withSkill.messages.some((msg: { event?: { type: string; value: string } }) =>
        msg.event?.type === "skill-created" && msg.event.value === "review",
      ),
    ).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}/skills/review`, { enabled: false })).body.enabled).toBe(false);
    expect((await api("GET", `/api/bots/${bot.id}/skills`)).body).toHaveLength(1);

    expect((await api("PATCH", `/api/bots/${bot.id}/autonomy`, { autonomy: "autonomous" })).body).toEqual({ autonomy: "autonomous" });
    expect((await api("PATCH", `/api/bots/${bot.id}/permissions`, { terminal: false })).body.terminal).toBe(false);
    expect((await api("GET", `/api/bots/${bot.id}/usage`)).body).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      turns: 0,
    });

    const privateBot = (await api("POST", "/api/bots", { visibility: "private" })).body.bot;
    expect((await api("PATCH", `/api/bots/${privateBot.id}/access`, { access: "full" })).body).toEqual({ access: "full" });
    expect((await api("GET", `/api/bots/${privateBot.id}/access`)).body).toEqual({ access: "full" });
    expect((await api("GET", `/api/bots/${privateBot.id}/autonomy`)).body).toEqual({ autonomy: "autonomous" });
    expect((await api("DELETE", `/api/bots/${privateBot.id}`)).status).toBe(200);

    expect((await api("DELETE", `/api/bots/${bot.id}/skills/review`)).status).toBe(200);
    expect((await api("DELETE", `/api/bots/${bot.id}/memory/facts/${fact.body.id}`)).status).toBe(200);
    expect((await api("GET", "/api/bots/missing/workspace")).status).toBe(404);
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  });

  it("uploads, downloads and scopes raw attachments", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const other = (await api("POST", "/api/bots")).body.bot;
    const upload = await fetch(`${BASE}/api/bots/${bot.id}/attachments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "text/plain",
        "x-file-name": encodeURIComponent("notes.txt"),
      },
      body: "hello attachment",
    });
    expect(upload.status).toBe(201);
    const file = await upload.json() as { id: string };

    const download = await fetch(`${BASE}/api/bots/${bot.id}/attachments/${file.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello attachment");
    expect((await fetch(`${BASE}/api/bots/${other.id}/attachments/${file.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).status).toBe(404);
    expect((await fetch(`${BASE}/api/bots/${bot.id}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain", "x-file-name": "..%2Fsecret" },
      body: "x",
    })).status).toBe(422);

    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "ghost", model: "" } });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "", attachmentIds: [file.id] })).status).toBe(409);
    expect((await api("POST", `/api/bots/${other.id}/messages`, { text: "", attachmentIds: [file.id] })).status).toBe(404);
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    expect((await fetch(`${BASE}/api/bots/${bot.id}/attachments/${file.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).status).toBe(404);
    await api("DELETE", `/api/bots/${other.id}`);
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    expect(body.instances.map((instance: { instanceId: string }) => instance.instanceId)).toEqual(
      expect.arrayContaining(["grok", "gemini", "kimi", "qwen", "claude", "codex", "ghost"]),
    );
    expect(body.instances.some((instance: { instanceId: string }) => ["slafy", "local"].includes(instance.instanceId))).toBe(false);
    const ghost = body.instances.find((instance: { instanceId: string }) => instance.instanceId === "ghost");
    expect(ghost).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(ghost.snapshot.reason).toContain("not-a-real-driver");
  });

  it("handles Hermes-style provider/model commands in chat", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const listed = await api("POST", `/api/bots/${bot.id}/messages`, { text: "/model" });
    expect(listed.status).toBe(200);
    const afterList = (await api("GET", "/api/bots")).body.bots.find((item: { id: string }) => item.id === bot.id);
    expect(afterList.messages.at(-1).text).toContain("Use /model <provider>/<model>");

    const unknown = await api("POST", `/api/bots/${bot.id}/messages`, { text: "/model nope/fake" });
    expect(unknown.status).toBe(200);
    const afterUnknown = (await api("GET", "/api/bots")).body.bots.find((item: { id: string }) => item.id === bot.id);
    expect(afterUnknown.messages.at(-1).text).toContain("Unknown model");
  });

  it("manages custom models without echoing API keys", async () => {
    const bad = await api("PUT", "/api/models/custom/claude", {
      displayName: "Reserved",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "x",
    });
    expect(bad.status).toBe(409);

    const saved = await api("PUT", "/api/models/custom/local-qwen", {
      displayName: "Local Qwen",
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "qwen2.5",
      apiKey: "test-secret-value",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.model).toEqual({
      id: "local-qwen",
      displayName: "Local Qwen",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5",
      hasKey: true,
    });
    expect(JSON.stringify(saved.body)).not.toContain("test-secret-value");

    const listed = await api("GET", "/api/models/custom");
    expect(listed.body.models).toContainEqual(saved.body.model);
    expect(JSON.stringify(listed.body)).not.toContain("test-secret-value");
    const instances = await api("GET", "/api/instances");
    expect(instances.body.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instanceId: "local-qwen",
          displayName: "Local Qwen",
          models: expect.objectContaining({ default: "qwen2.5" }),
        }),
      ]),
    );

    expect((await api("DELETE", "/api/models/custom/local-qwen")).status).toBe(200);
    expect((await api("GET", "/api/models/custom")).body.models).toEqual([]);
  });

  it("persists command-line tool allow switches", async () => {
    const disabled = await api("PUT", "/api/cli-tools/codex", { enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.tool).toMatchObject({ id: "codex", enabled: false, detected: false });
    const listed = await api("GET", "/api/cli-tools");
    expect(listed.body.tools.find((tool: { id: string }) => tool.id === "codex")).toMatchObject({
      enabled: false,
      reason: "disabled in settings",
    });
    const instance = (await api("GET", "/api/instances")).body.instances.find(
      (item: { instanceId: string }) => item.instanceId === "codex",
    );
    expect(instance.snapshot).toMatchObject({ state: "unavailable", reason: "disabled in settings" });
    expect((await api("PUT", "/api/cli-tools/codex", { enabled: true })).status).toBe(200);
    expect((await api("PUT", "/api/cli-tools/unknown", { enabled: true })).status).toBe(404);
  });

  it("reports device capabilities for onboarding", async () => {
    const { status, body } = await api("GET", "/api/device");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      python: expect.any(Boolean),
      docker: expect.any(Boolean),
    });
    expect(body.hostname).toBeTruthy();
    expect(body.memoryGb).toBeGreaterThan(0);
    expect(body.ramBytes).toBeGreaterThan(0);
  });

  it("exposes fixed CLI installers without running them", async () => {
    const listed = await api("GET", "/api/cli-tools");
    expect(listed.status).toBe(200);
    expect(listed.body.tools.find((tool: { id: string }) => tool.id === "kimi")).toMatchObject({
      driverKind: "kimiAgent",
      installCommand: "Native installer for this device",
    });
    expect(listed.body.tools.find((tool: { id: string }) => tool.id === "qwen")).toMatchObject({
      driverKind: "qwenAgent",
      installCommand: "npm install -g @qwen-code/qwen-code@latest",
    });
    expect((await api("POST", "/api/cli-tools/unknown/install")).status).toBe(404);
    expect((await api("POST", "/api/cli-tools/grok/install")).status).toBe(409);
  });

  it("exposes official interactive login commands without starting them in metadata", async () => {
    const listed = await api("GET", "/api/cli-tools");
    expect(listed.body.tools.find((tool: { id: string }) => tool.id === "claude")).toMatchObject({
      loginCommand: "claude auth login",
      loginAvailable: true,
      installCommand: "Native installer for this device",
    });
    expect(listed.body.tools.find((tool: { id: string }) => tool.id === "codex")).toMatchObject({
      loginCommand: "codex login --device-auth",
      loginAvailable: true,
      loginMode: "device",
    });
    expect((await api("POST", "/api/cli-tools/grok/login")).status).toBe(409);
  });

  it("streams persisted setup progress using the onboarding SSE shape", async () => {
    const response = await fetch(`${BASE}/api/progress/done-job`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain(
      `data: ${JSON.stringify({ id: "done-job", step: "Install bot server", message: "browser ready", done: true })}`,
    );
    expect((await api("GET", "/api/progress/missing-job")).status).toBe(404);
  });

  it("creates, patches, and deletes a bot", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed", pinned: true });
    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({ name: "Renamed", pinned: true });

    // multibot: zmiana nazwy zostawia w transkrypcie pigułkę zdarzenia —
    // regresja po smoke teście, w którym eventu nie było wcale.
    const renamed = await api("GET", "/api/bots");
    const withEvent = renamed.body.bots.find((b: { id: string }) => b.id === bot.id);
    const event = withEvent.messages.find((m: { kind: string; event?: { type: string } }) => m.kind === "event");
    expect(event?.event).toMatchObject({ type: "renamed", value: "Renamed" });
    // patch bez zmiany nazwy nie dokłada kolejnej pigułki
    await api("PATCH", `/api/bots/${bot.id}`, { pinned: false });
    const again = await api("GET", "/api/bots");
    const events = again.body.bots
      .find((b: { id: string }) => b.id === bot.id)
      .messages.filter((m: { kind: string }) => m.kind === "event");
    expect(events).toHaveLength(1);

    const missing = await api("PATCH", "/api/bots/does-not-exist", { name: "x" });
    expect(missing.status).toBe(404);

    const deleted = await api("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === bot.id)).toBeUndefined();
  });

  // multibot: kolor spoza allowlisty zapisywal sie cicho, a klient rysowal
  // takiego bota domyslna zielenia — wygladalo to jak „bot bez koloru".
  it("rejects an unknown bot colour and accepts black", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;

    const bad = await api("PATCH", `/api/bots/${bot.id}`, { color: "pink2" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("unknown color");

    const black = await api("PATCH", `/api/bots/${bot.id}`, { color: "black" });
    expect(black.status).toBe(200);
    expect(black.body.bot.color).toBe("black");
  });

  it("patches a bot section with validation and clearing (multibot port OMB #296)", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;

    const assigned = await api("PATCH", `/api/bots/${bot.id}`, { section: "  Research  " });
    expect(assigned.status).toBe(200);
    expect(assigned.body.bot.section).toBe("Research");

    const tooLong = await api("PATCH", `/api/bots/${bot.id}`, { section: "x".repeat(61) });
    expect(tooLong.status).toBe(400);

    const wrongType = await api("PATCH", `/api/bots/${bot.id}`, { section: 7 });
    expect(wrongType.status).toBe(400);

    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { section: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot.section).toBeUndefined();

    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("persists an answered onboarding card", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("PATCH", `/api/bots/${bot.id}/cards/${card.id}`, { answered: card.card.options[0] });
    expect(res.status).toBe(200);
    expect(res.body.message.card.answered).toBe(card.card.options[0]);
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "ghost", model: "" },
    });

    const empty = await api("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    // A bot explicitly bound to the ghost instance must fail loudly, not
    // 202-and-hang.
    const send = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.box).toEqual({ configured: false });

    const put = await api("PUT", "/api/config", { box: { token: "tok_secret_value" } });
    expect(put.status).toBe(200);
    expect(put.body.box).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("tok_secret_value");

    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("tok_secret_value");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("stores and echoes the user profile (not write-only, unlike keys)", async () => {
    const put = await api("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });
  });

  // multibot: strefa czasowa i autoweryfikacja jadą tym samym /api/config co
  // reszta ustawień — UI nie dostaje osobnego API. Test pilnuje CAŁEJ pętli:
  // zapis, odesłanie w odpowiedzi i przeżycie do następnego GET-a (bez wpisu
  // w białej liście `saveConfig` zapis przepadał po cichu).
  it("saves and echoes the time zone and the auto-verify rules", async () => {
    const fresh = await api("GET", "/api/config");
    expect(fresh.body.timeZone).toBe("");
    expect(fresh.body.autoVerify).toEqual({ enabled: true, rules: [] });

    const zone = await api("PUT", "/api/config", { timeZone: "  Europe/Warsaw  " });
    expect(zone.status).toBe(200);
    expect(zone.body.timeZone).toBe("Europe/Warsaw");

    const rules = await api("PUT", "/api/config", {
      autoVerify: { enabled: true, rules: [{ id: "r1", when: "odpowiadaj na maile", decision: "allow" }] },
    });
    expect(rules.status).toBe(200);
    expect(rules.body.autoVerify.rules).toEqual([{ id: "r1", when: "odpowiadaj na maile", decision: "allow" }]);
    // zapis samych reguł nie może zgubić strefy zapisanej wcześniej
    expect(rules.body.timeZone).toBe("Europe/Warsaw");

    // sam przełącznik, bez listy — reguły zostają na miejscu
    const off = await api("PUT", "/api/config", { autoVerify: { enabled: false } });
    expect(off.body.autoVerify).toEqual({
      enabled: false,
      rules: [{ id: "r1", when: "odpowiadaj na maile", decision: "allow" }],
    });

    // usunięcie reguły = zapis krótszej listy tym samym kanałem
    const cleared = await api("PUT", "/api/config", { autoVerify: { enabled: true, rules: [] } });
    expect(cleared.body.autoVerify).toEqual({ enabled: true, rules: [] });

    // pusta strefa jest znacząca: "wykryj automatycznie"
    expect((await api("PUT", "/api/config", { timeZone: "" })).body.timeZone).toBe("");
    const after = await api("GET", "/api/config");
    expect(after.body.timeZone).toBe("");
    expect(after.body.autoVerify).toEqual({ enabled: true, rules: [] });
  });

  // multibot: kolejność sekcji sidebaru mieszka na serwerze, żeby desktop i
  // telefon układały listę tak samo. Zapis jest podmianą całej listy — inaczej
  // przestawienie nie umiałoby usunąć nazwy, której już nikt nie używa.
  it("saves and echoes the sidebar section order", async () => {
    expect((await api("GET", "/api/config")).body.sectionOrder).toEqual([]);

    const saved = await api("PUT", "/api/config", { sectionOrder: ["  GitHub  ", "Workers", "GitHub", "", 7] });
    expect(saved.status).toBe(200);
    expect(saved.body.sectionOrder).toEqual(["GitHub", "Workers"]);

    // pełna podmiana: przestawienie i usunięcie sekcji jednym zapisem
    const moved = await api("PUT", "/api/config", { sectionOrder: ["Workers"] });
    expect(moved.body.sectionOrder).toEqual(["Workers"]);
    expect((await api("GET", "/api/config")).body.sectionOrder).toEqual(["Workers"]);

    // zapis innego ustawienia nie może zgubić kolejności
    expect((await api("PUT", "/api/config", { timeZone: "" })).body.sectionOrder).toEqual(["Workers"]);
  });

  // multibot (F7): własne serwery MCP użytkownika — osobna trasa `/custom/`,
  // wspólny katalog z Composio (karta niesie `source`).
  it("registers a custom MCP connector and tags it in the integrations catalog", async () => {
    const bad = await api("PUT", "/api/connectors/custom/echo", { transport: { type: "stdio" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("command required");

    const saved = await api("PUT", "/api/connectors/custom/echo", {
      name: "Echo",
      transport: { type: "stdio", command: "node", args: ["echo.mjs"], env: { TOKEN: "sekret" } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.connector).toMatchObject({ id: "echo", name: "Echo" });

    const catalog = await api("GET", "/api/connectors/catalog");
    expect(catalog.status).toBe(200);
    const custom = catalog.body.cards.filter((c: { source: string }) => c.source === "custom");
    expect(custom).toEqual([
      { slug: "echo", label: "Echo", blurb: "stdio: node echo.mjs", logo: null, domain: null, source: "custom" },
    ]);
    // Composio zostaje primary: jego karty są w tym samym katalogu, otagowane.
    expect(catalog.body.cards.filter((c: { source: string }) => c.source === "composio").length).toBeGreaterThan(0);
    // sekret konektora nie wychodzi katalogiem
    expect(JSON.stringify(catalog.body)).not.toContain("sekret");

    const gone = await api("DELETE", "/api/connectors/custom/echo");
    expect(gone.status).toBe(200);
    const after = await api("GET", "/api/connectors/catalog");
    expect(after.body.cards.some((c: { source: string }) => c.source === "custom")).toBe(false);
  });

  // Tunel (cloudflared --url) buforuje odpowiedź SSE do końca strumienia, więc
  // `/api/events` po SSE nie dowozi zdalnej apce ani jednej ramki — wysłany
  // dymek zostaje szary. WebSocket ten sam tunel przepuszcza na żywo.
  it("dowozi zdarzenia po WebSocket na tej samej ścieżce co SSE", async () => {
    const socket = new WebSocket(`${BASE.replace("http", "ws")}/api/events?lang=pl`, [
      "multibot-v2",
      TOKEN,
    ]);
    const frames: any[] = [];
    let resolveFrame: (() => void) | null = null;
    socket.onmessage = (event) => {
      frames.push(JSON.parse(String(event.data)));
      resolveFrame?.();
    };
    const next = () => new Promise<void>((resolve) => (resolveFrame = resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("upgrade odrzucony"));
      });
      await Promise.race([next(), new Promise((r) => setTimeout(r, 5_000))]);
      expect(frames[0]).toEqual({ kind: "hello" });

      const created = await api("POST", "/api/bots");
      expect(created.status).toBe(201);
      await api("PATCH", `/api/bots/${created.body.bot.id}`, { name: "Ws Test" });
      const deadline = Date.now() + 5_000;
      while (!frames.some((f) => f.kind === "bot" && f.bot?.name === "Ws Test") && Date.now() < deadline) {
        await Promise.race([next(), new Promise((r) => setTimeout(r, 200))]);
      }
      expect(frames.some((f) => f.kind === "bot" && f.bot?.name === "Ws Test")).toBe(true);
      await api("DELETE", `/api/bots/${created.body.bot.id}`);
    } finally {
      socket.close();
    }
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });

  // cfg.profile jest WSPÓLNY dla całego serwera. Zanim to naprawiliśmy, dowolny
  // członek nadpisywał nim nazwę i e-mail wszystkim; nazwa konta należy do
  // konta i idzie przez identity.
  it("keeps shared config profile owner-only while every member renames themselves", async () => {
    const joined = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "index-member",
        password: "index-member-profile-pass",
        displayName: "Index Member",
        serverName,
        serverPassword,
        deviceName: "vitest-member",
      }),
    });
    expect(joined.status).toBe(201);
    const memberToken = (await joined.json() as { accessToken: string }).accessToken;
    const asMember = (body: unknown) => fetch(`${BASE}/api/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const ownerBefore = (await api("GET", "/api/config")).body.profile;
    const renamed = await asMember({ profile: { name: "Member Renamed", email: "member@example.test" } });
    expect(renamed.status).toBe(200);
    // Own display name changed…
    expect((await renamed.json() as { profile: { name: string } }).profile.name).toBe("Member Renamed");
    // …a wspólny profil serwera został nietknięty dla właściciela.
    expect((await api("GET", "/api/config")).body.profile).toEqual(ownerBefore);

    // Za długa nazwa to 422, nie 500.
    expect((await asMember({ profile: { name: "x".repeat(81) } })).status).toBe(422);

    // Owner nadal pisze do wspólnego profilu.
    const asOwner = await api("PATCH", "/api/config", { profile: { name: "Index Tester", email: "owner@example.test" } });
    expect(asOwner.status).toBe(200);
    expect((await api("GET", "/api/config")).body.profile.email).toBe("owner@example.test");
  });

  // The identity access token is the whole credential surface now: the SSE
  // stream opens with it, and every retired rail is simply gone.
  it("streams events with the identity access token and has no legacy auth rails left", async () => {
    const events = await fetch(`${BASE}/api/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("\"kind\":\"hello\"");
    void reader.cancel();

    // Authenticated, so a surviving handler would answer 200 — these are gone.
    for (const path of ["/api/auth/token", "/api/auth/status", "/api/pair"]) {
      expect((await api("GET", path)).status).toBe(404);
    }
    for (const path of ["/api/auth/token/rotate", "/api/pair/start", "/api/pair/claim", "/api/auth/firebase/session", "/api/workspace/invites"]) {
      expect((await api("POST", path, {})).status).toBe(404);
    }
    // …ale `/api/provision` zostaje do PR 7 — onboarding świeżej instalacji je woła.
    expect((await api("POST", "/api/provision", { server: false })).status).toBe(202);
    // An old client with the retired bearer is just anonymous: 401, never 426.
    for (const path of ["/api/auth/token", "/api/pair", "/api/auth/status", "/api/bots"]) {
      expect((await fetch(`${BASE}${path}`, { headers: { authorization: "Bearer index-test-legacy-token" } })).status).toBe(401);
    }
  });

  // The three values are credentials. A port scan sees that a MultiBot server
  // is there and nothing that helps join it.
  it("publishes the server name and id, never the password", async () => {
    for (const path of ["/api/public/server", "/api/public/handshake"]) {
      const info = await (await fetch(`${BASE}${path}`)).json() as Record<string, unknown>;
      expect(info.configured).toBe(true);
      expect(info.serverId).toBeTruthy();
      // The sign-in header shows the name, so the public route carries it.
      expect(info.name).toBe(serverName);
      expect(JSON.stringify(info)).not.toContain(serverPassword);
    }
    const own = (await api("GET", "/api/server")).body;
    expect(own.name).toBe(serverName);
    expect(own.publicAddress).toBeNull();
  });

  it("hands the setup values to loopback only, and only until a profile exists", async () => {
    expect(setupValuesBehindProxy).toBe(404);
    // …and a local app that cannot read setup.json gets nothing either.
    expect(setupValuesWithoutToken).toBe(404);
    // Trzy wartości opisują serwer po HTTPS i niosą odcisk, po którym klient
    // pozna, że rozmawia z TYM serwerem (server/tls-cert.ts).
    expect(setupAddress).toMatch(/^https:\/\//);
    expect(setupFingerprint).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // beforeAll already registered the owner, so the route is closed for good.
    expect((await fetch(`${BASE}/api/setup/values`)).status).toBe(404);
    expect(existsSync(join(home, ".openmausbot", "setup.json"))).toBe(false);
    // …and the retired setup route is gone with it.
    expect((await api("POST", "/api/setup/server", { name: "nope" })).status).toBe(404);
  });

  it("joins with the three values, spends the grant once, and names the wrong field", async () => {
    const join = async (body: unknown) => {
      const res = await fetch(`${BASE}/api/auth/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as { joinGrant?: string; hasUsers?: boolean; error?: string } };
    };
    expect(await join({ serverName: "not-this-server", serverPassword })).toMatchObject({ status: 401, body: { error: "wrong_server_name" } });
    expect(await join({ serverName, serverPassword: "not-the-password" })).toMatchObject({ status: 401, body: { error: "wrong_server_password" } });

    const ok = await join({ serverName, serverPassword });
    expect(ok.status).toBe(200);
    expect(ok.body.hasUsers).toBe(true);
    const signIn = async () => fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "index-tester", password: "index-test-profile-password", joinGrant: ok.body.joinGrant }),
    });
    expect((await signIn()).status).toBe(200);
    expect((await signIn()).status).toBe(401); // single use
  });

  it("stores an e-mail on the profile and hands it back with the account", async () => {
    expect((await api("PATCH", "/api/profile", { displayName: "Index Tester", email: "index@example.test" })).body.user.email).toBe("index@example.test");
    expect((await api("GET", "/api/auth/me")).body.user.email).toBe("index@example.test");
  });

  // Last in the file on purpose: it registers extra profiles and disables one,
  // so nothing above it can be perturbed by the state it leaves behind.
  it("keeps the admin overview owner-only and acts on profiles from it", async () => {
    const enroll = async (username: string) => {
      const res = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: "member-test-profile-pw", serverName, serverPassword, deviceName: "vitest" }),
      });
      expect(res.status).toBe(201);
      return await res.json() as { user: { id: string; role: string }; accessToken: string };
    };
    const asMember = (token: string, method: string, path: string, body?: unknown) => fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "x-multibot-protocol": "2", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

    const member = await enroll("index-disabled");
    expect(member.user.role).toBe("member");
    expect((await asMember(member.accessToken, "GET", "/api/admin/overview")).status).toBe(403);
    expect((await asMember(member.accessToken, "PATCH", `/api/admin/users/${member.user.id}`, { role: "owner" })).status).toBe(403);

    const overview = await api("GET", "/api/admin/overview");
    expect(overview.status).toBe(200);
    const owner = overview.body.users.find((user: any) => user.role === "owner");
    expect(owner.username).toBe("index-tester");
    expect(typeof owner.lastSeenAt).toBe("number");
    expect(typeof owner.messages).toBe("number");
    expect(overview.body.users.map((user: any) => user.username)).toEqual(expect.arrayContaining(["index-tester", "index-member", "index-disabled"]));
    expect(overview.body.server.cpuCount).toBeGreaterThan(0);
    expect(overview.body.server.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof overview.body.server.connectionsActive).toBe("number");
    expect(overview.body.server.tlsFingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/);
    expect(Object.keys(overview.body.bots.byVisibility).sort()).toEqual(["private", "public", "team"]);
    expect(overview.body.performance).toMatchObject({ turns24h: expect.any(Number), errorRate: expect.any(Number) });
    expect(overview.body.audit.some((row: any) => row.action === "user.registered")).toBe(true);

    // Owner resets a forgotten profile: a code, shown once, never stored plain.
    const reset = await api("POST", `/api/admin/users/${member.user.id}/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body.recoveryCode).toMatch(/^[\w-]{20,}$/);

    // Disabling takes effect on the credential that profile already holds.
    const disabled = await api("PATCH", `/api/admin/users/${member.user.id}`, { disabled: true });
    expect(disabled.status).toBe(200);
    expect(disabled.body.user.disabled).toBe(true);
    expect((await asMember(member.accessToken, "GET", "/api/bots")).status).toBe(401);
    expect((await asMember(member.accessToken, "GET", "/api/admin/overview")).status).toBe(401);

    // The server must always keep one enabled owner, whoever asks.
    expect((await api("PATCH", `/api/admin/users/${owner.id}`, { role: "member" })).status).toBe(409);
    expect((await api("PATCH", `/api/admin/users/${owner.id}`, { disabled: true })).status).toBe(409);
    expect((await api("GET", "/api/auth/me")).body.user.role).toBe("owner");
    expect((await api("PATCH", "/api/admin/users/usr_nobody", { disabled: true })).status).toBe(404);
    // An unmatched admin path stops inside the owner-gated block instead of
    // falling through to a handler that never saw the prefix.
    expect((await api("GET", "/api/admin/nope")).status).toBe(404);
    expect((await asMember(member.accessToken, "GET", "/api/admin/nope")).status).toBe(401);
  });
});
