import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";

import { isPublicRoute, mountAuth } from "./auth.ts";
import { isLoopbackRequest } from "./identity.ts";

// Jedna szyna: identity v2. Nie ma allowlisty dla parowania ani Firebase, nie
// ma 426 — niezalogowany dostaje 401 i tyle.
describe("public allowlist", () => {
  it("nie wpuszcza tras parowania ani Firebase", () => {
    expect(isPublicRoute("POST", "/api/pair/claim")).toBe(false);
    expect(isPublicRoute("POST", "/api/pair/start")).toBe(false);
    expect(isPublicRoute("GET", "/api/pair")).toBe(false);
    expect(isPublicRoute("POST", "/api/auth/firebase/session")).toBe(false);
    expect(isPublicRoute("GET", "/api/auth/status")).toBe(false);
    expect(isPublicRoute("GET", "/api/auth/token")).toBe(false);
  });

  it("wpuszcza tylko to, czego ekran logowania naprawdę potrzebuje", () => {
    expect(isPublicRoute("GET", "/api/public/server")).toBe(true);
    expect(isPublicRoute("GET", "/api/health")).toBe(true);
    // Gated inside the handler by loopback + "no profile yet", not by the gate.
    expect(isPublicRoute("GET", "/api/setup/values")).toBe(true);
    // Setting a server up is not a request any more — it happens on boot.
    expect(isPublicRoute("POST", "/api/setup/server")).toBe(false);
    expect(isPublicRoute("POST", "/api/auth/join")).toBe(true);
    expect(isPublicRoute("POST", "/api/auth/login")).toBe(true);
    expect(isPublicRoute("POST", "/api/auth/register")).toBe(true);
    // statyczna powłoka tak, dane nigdy
    expect(isPublicRoute("GET", "/index.html")).toBe(true);
    expect(isPublicRoute("GET", "/api/bots")).toBe(false);
  });
});

// Tunel albo reverse proxy sprawia, że KAŻDE żądanie wygląda na 127.0.0.1.
// Nagłówek przekazujący adres jest dowodem, że rozmówca lokalny NIE jest.
describe("isLoopbackRequest", () => {
  const req = (headers: Record<string, string>, remoteAddress = "127.0.0.1") =>
    ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

  it("jest prawdą tylko dla gołego loopbacku", () => {
    expect(isLoopbackRequest(req({}))).toBe(true);
    expect(isLoopbackRequest(req({}, "::1"))).toBe(true);
    expect(isLoopbackRequest(req({}, "::ffff:127.0.0.1"))).toBe(true);
    expect(isLoopbackRequest(req({}, "10.0.0.7"))).toBe(false);
  });

  it("jest fałszem, gdy żądanie przyszło przez pośrednika", () => {
    expect(isLoopbackRequest(req({ "x-forwarded-for": "1.2.3.4" }))).toBe(false);
    expect(isLoopbackRequest(req({ "x-real-ip": "1.2.3.4" }))).toBe(false);
  });
});

describe("mountAuth", () => {
  async function withServer(
    authenticated: (req: IncomingMessage) => boolean,
    run: (base: string) => Promise<void>,
  ) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    mountAuth(server, authenticated);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it("odrzuca anonimowe wywołanie API przez 401, nigdy 426", async () => {
    await withServer(() => false, async (base) => {
      const anonymous = await fetch(`${base}/api/bots`);
      expect(anonymous.status).toBe(401);
      // stary klient z bearerem to teraz też po prostu anonim
      const legacy = await fetch(`${base}/api/bots`, { headers: { authorization: "Bearer legacy-token" } });
      expect(legacy.status).toBe(401);
      expect((await fetch(`${base}/api/auth/status`)).status).toBe(401);
      expect((await fetch(`${base}/api/pair`)).status).toBe(401);
      expect((await fetch(`${base}/api/pair/claim`, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(`${base}/api/auth/firebase/session`, { method: "POST", body: "{}" })).status).toBe(401);
    });
  });

  it("wpuszcza poświadczenie identity", async () => {
    await withServer((req) => req.headers.cookie === "mb_v2_session=good", async (base) => {
      expect((await fetch(`${base}/api/bots`, { headers: { cookie: "mb_v2_session=good" } })).status).toBe(200);
      expect((await fetch(`${base}/api/bots`, { headers: { cookie: "mb_v2_session=revoked" } })).status).toBe(401);
    });
  });

  // H4: statyczny klient noVNC (strona + assety) jest publiczny — to sam
  // podgląd, bez danych. Ekran chroni brama na upgradzie WS.
  it("serwuje stronę noVNC bez poświadczenia, resztę trzyma za bramą", async () => {
    await withServer(() => false, async (base) => {
      expect((await fetch(`${base}/api/bots/b1/computer/vnc/vnc_lite.html`)).status).toBe(200);
      expect((await fetch(`${base}/api/bots/b1/computer/vnc/app/ui.js`)).status).toBe(200);
      expect((await fetch(`${base}/api/bots/b1/computer`)).status).toBe(401);
      expect((await fetch(`${base}/api/bots/b1/computer/exec`)).status).toBe(401);
    });
  });

  // Websockify na ekranie komputera niesie poświadczenie w `?token=`; czyta je
  // `identity.actorForRequest`, więc bramka pyta o dokładnie to samo co wszędzie.
  it("przepuszcza upgrade websockify wyłącznie z ważnym ?token=", async () => {
    const server = createServer();
    let reached = false;
    server.on("upgrade", (_req, socket: Duplex) => {
      reached = true;
      socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    });
    mountAuth(server, (req) => new URL(req.url ?? "/", "http://localhost").searchParams.get("token") === "good");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const status = (query: string) =>
      new Promise<string>((resolve) => {
        const s = connect(port, "127.0.0.1", () => {
          s.write(
            `GET /api/bots/b1/computer/vnc/websockify${query} HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
          );
        });
        let buf = "";
        s.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("\r\n")) resolve(buf.split("\r\n")[0]);
        });
        s.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
        setTimeout(() => resolve("(no response)"), 3000);
      });

    try {
      reached = false;
      expect(await status("")).toBe("HTTP/1.1 401 Unauthorized");
      expect(reached).toBe(false);

      reached = false;
      expect(await status("?token=good")).toContain("101");
      expect(reached).toBe(true);

      reached = false;
      expect(await status("?token=wrong")).toBe("HTTP/1.1 401 Unauthorized");
      expect(reached).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
