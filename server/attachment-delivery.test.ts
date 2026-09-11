import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapAccessToken } from "./testing/identity.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = `https://127.0.0.1:${21000 + Math.floor(Math.random() * 10000)}`;
let home: string;
let child: ChildProcess;
let token = "";
let stderr = "";
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000;
  while (!await check()) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${label}: ${stderr.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "multibot-delivery-"));
  mkdirSync(join(home, ".multibot"));
  const cli = join(root, "server/testing/fake-acp-cli.ts");
  chmodSync(cli, 0o755);
  writeFileSync(join(home, ".multibot/config.json"), JSON.stringify({ instances: {
    files: { driver: "grokAgent", config: { cli, fullAuto: true }, environment: {
      FAKE_ACP_MODE: "send-files", FAKE_ATTACHMENT_CALLS: join(home, "calls.json"), FAKE_ATTACHMENT_RESULTS: join(home, "results.json"),
    } },
  } }));
  child = spawn(process.execPath, [join(root, "server/index.ts")], { windowsHide: true, cwd: root, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    MULTIBOT_PORT: new URL(base).port, MULTIBOT_HOST: "127.0.0.1", MULTIBOT_COMPUTER: "off",
    MULTIBOT_AUTO_UPDATE: "0", MULTIBOT_ONBOARDING_TURN: "0", MULTIBOT_TURN_DEBOUNCE_MS: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  await until(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "server boot");
  token = await bootstrapAccessToken(base, home);
}, 120_000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
  // multibot: Windows may release child cwd handles a moment after exit.
  if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 750));
  try {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    // Windows AV/indexers can retain directory metadata after every child
    // has exited. Temp cleanup must not turn a green acceptance run red.
    if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error;
  }
});

describe("bot file delivery through real MCP, HTTP and transcript", () => {
  it("persists a downloadable attachment when the provider ends without assistant text", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "files", model: "fake" } });
    const path = join(home, "report.txt");
    writeFileSync(path, "report bytes");
    writeFileSync(join(home, "calls.json"), JSON.stringify([{ path, mime: "text/plain" }]));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "send report" })).status).toBe(202);
    await until(async () => existsSync(join(home, "results.json")) && !(await api("GET", `/api/bots/${bot.id}`)).body.bot.busy, "file turn");
    expect(readFileSync(join(home, "results.json"), "utf8")).toContain("File sent to the chat");
    const messages = (await api("GET", `/api/bots/${bot.id}`)).body.bot.messages;
    const message = messages.find((m: any) => m.attachments?.length);
    expect(message, "tool success must already be a visible persisted chat message").toBeDefined();
    const disk = JSON.parse(readFileSync(join(home, `.multibot/messages-${bot.threadId}.json`), "utf8"));
    expect(disk.find((m: any) => m.id === message.id).attachments).toEqual(message.attachments);
    const response = await fetch(`${base}/api/bots/${bot.id}/attachments/${message.attachments[0].id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("report bytes");
    // A turn that delivered a file DID answer — the "model wrote nothing"
    // note is false and must not appear after a file-only turn.
    const silent = messages.filter((m: any) => typeof m.text === "string"
      && (m.text.includes("turn ended without an answer") || m.text.includes("tura skończona bez odpowiedzi")));
    expect(silent, "file-only turn must not get the silent-turn note").toEqual([]);
  }, 120_000);

  it("routes a file sent during a group turn to the group ledger, not the private chat", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "files", model: "fake" } });
    const group = (await api("POST", "/api/groups", { name: "Files", bot_ids: [bot.id] })).body;
    const path = join(home, "group-report.txt");
    writeFileSync(path, "group bytes");
    rmSync(join(home, "results.json"), { force: true });
    writeFileSync(join(home, "calls.json"), JSON.stringify([{ path, mime: "text/plain" }]));
    const chat = await api("POST", `/api/groups/${group.id}/chat`, { message: "send the report to the group" });
    expect(chat.status).toBe(200);
    // The private chat must NOT show the file: the group turn's output belongs
    // to the group (regression: bd63f22 wrote it to the private thread).
    const messages = (await api("GET", `/api/bots/${bot.id}`)).body.bot.messages;
    const leaked = messages.filter((m: any) => m.attachments?.length && !m.hidden);
    expect(leaked, "group-turn file must not surface in the private chat").toEqual([]);
    // The group sees the file as a download link in its ledger.
    const stored = (await api("GET", `/api/groups/${group.id}`)).body;
    const link = stored.messages.find((m: any) => typeof m.text === "string" && m.text.includes(`/api/bots/${bot.id}/attachments/`));
    expect(link, "group ledger must carry the file link").toBeDefined();
    const id = link.text.match(/attachments\/([0-9a-f-]{36})/)?.[1];
    const response = await fetch(`${base}/api/bots/${bot.id}/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("group bytes");
  }, 180_000);
});
