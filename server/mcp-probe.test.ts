// multibot: „testuj połączenie" gada z PRAWDZIWYM serwerem MCP — stdio z
// `server/testing/fake-mcp-server.ts` (JSON po liniach) i lokalnym serwerem
// HTTP, który odpowiada SSE i wymaga `mcp-session-id`. Atrapa modułu przeszłaby
// także przy złym framingu, więc jej tu nie ma.
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeMcp } from "./mcp-probe.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-mcp-server.ts");
const stdio = (env?: Record<string, string>) =>
  ({ type: "stdio" as const, command: process.execPath, args: [FAKE], ...(env ? { env } : {}) });

describe("probeMcp over stdio", () => {
  it("handshakes and lists the tool names", async () => {
    const result = await probeMcp(stdio(), 15_000);
    expect(result).toEqual({ ok: true, tools: ["echo", "ping"], serverName: "fake-echo" });
  });

  it("survives a server that also logs plain text to stdout", async () => {
    const result = await probeMcp(stdio({ FAKE_MCP_MODE: "noisy" }), 15_000);
    expect(result).toMatchObject({ ok: true, tools: ["echo", "ping"] });
  });

  it("reports a JSON-RPC error instead of throwing", async () => {
    const result = await probeMcp(stdio({ FAKE_MCP_MODE: "fail" }), 15_000);
    expect(result).toEqual({ ok: false, error: "nope, bad auth" });
  });

  // Sekret konektora wraca do UI tylko jako „…" — serwery MCP potrafią wypluć
  // swój własny token na stderr, a `error` idzie prosto na ekran.
  it("never echoes a connector secret back in the error", async () => {
    const result = await probeMcp(stdio({ FAKE_MCP_MODE: "leak", SECRET_TOKEN: "tok-do-not-leak-me" }), 15_000);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("boom: bad token");
    expect(JSON.stringify(result)).not.toContain("tok-do-not-leak-me");
  });

  it("gives up on a server that never answers, without hanging", async () => {
    const started = Date.now();
    const result = await probeMcp(stdio({ FAKE_MCP_MODE: "mute" }), 400);
    expect(result).toEqual({ ok: false, error: "no answer within 400 ms" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("turns a missing command into a result, not a crash", async () => {
    const result = await probeMcp({ type: "stdio", command: "multibot-no-such-binary-xyz" }, 5_000);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/ENOENT|not found|no such/i);
  });
});

describe("probeMcp over http", () => {
  let server: Server;
  let url = "";
  const seen: Array<{ method: string; auth?: string; session?: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.url === "/deny") {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "bad token" }));
        }
        const msg = JSON.parse(raw || "{}");
        seen.push({
          method: msg.method,
          auth: req.headers.authorization as string | undefined,
          session: req.headers["mcp-session-id"] as string | undefined,
        });
        if (msg.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-42" });
          return res.end(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "http-echo" } },
          }));
        }
        if (!msg.id) return res.writeHead(202).end(); // notyfikacja: 202, bez ciała
        if (req.headers["mcp-session-id"] !== "sess-42") {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "no session" } }));
        }
        // ta sama odpowiedź co streamable-HTTP: linie SSE, nie gołe JSON —
        // i NAJPIERW notyfikacja postępu, żeby „weź pierwsze data:" tu poległo
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`
          + `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search" }] } })}\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("carries the headers and the session id through the handshake", async () => {
    const result = await probeMcp({ type: "http", url, headers: { authorization: "Bearer tajne" } }, 15_000);
    expect(result).toEqual({ ok: true, tools: ["search"], serverName: "http-echo" });
    expect(seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(seen.every((s) => s.auth === "Bearer tajne")).toBe(true);
    expect(seen[2].session).toBe("sess-42"); // nagłówek z initialize wrócił
  });

  it("turns a non-2xx into a result and keeps the token out of it", async () => {
    const result = await probeMcp({ type: "http", url: url.replace("/mcp", "/deny"), headers: { authorization: "Bearer tajne" } }, 15_000);
    expect(result).toEqual({ ok: false, error: "HTTP 401 Unauthorized" });
    expect(JSON.stringify(result)).not.toContain("tajne");
  });

  it("reports an unreachable url instead of throwing", async () => {
    const result = await probeMcp({ type: "http", url: "http://127.0.0.1:1/mcp" }, 5_000);
    expect(result.ok).toBe(false);
  });
});
