// multibot: one gate for the whole harness. Public allowlist first, then the
// identity v2 credential (session cookie, access-token bearer, or the WS
// subprotocol / `?token=` the screen's websockify upgrade carries), then 401.
// There is no second rail any more: an unauthenticated caller is always 401,
// never 426.
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";

import { matchVncRoute } from "./computer-vnc-proxy.ts";
import { isIdentityPublicRoute } from "./identity.ts";

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function rejectUpgrade(socket: Duplex) {
  socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

export function isPublicRoute(method: string, pathname: string): boolean {
  return (
    isIdentityPublicRoute(method, pathname) ||
    (method === "POST" && /^\/webhooks\/[^/]+$/.test(pathname)) ||
    // multibot (H4): the noVNC client itself (page + JS/CSS) is public — it is
    // the viewer, not the data. The screen is gated at the WS upgrade, and a
    // mobile WebView iframe carries no credential on subresource loads.
    ((method === "GET" || method === "HEAD") && matchVncRoute(pathname) !== null) ||
    ((method === "GET" || method === "HEAD") &&
      !pathname.startsWith("/api/") &&
      !pathname.startsWith("/webhooks/"))
  );
}

/** Where the gate leaves the actor it already resolved. Handlers read it back
 * with `requestActor` instead of parsing the credential again — one lookup per
 * request/upgrade, not one per frame. */
const ACTOR_KEY = "multibotActor";

export function requestActor<T>(req: IncomingMessage): T | null {
  return (req as unknown as Record<string, T | undefined>)[ACTOR_KEY] ?? null;
}

/** Mount last: wraps both the app request handler and every upgrade handler,
 * including the events and per-bot computer sockets. `authenticate` is the
 * identity lookup — it already reads the cookie, the bearer, the `multibot-v2`
 * subprotocol and the screen's `?token=` — and returns the actor or null. */
export function mountAuth<T>(server: HttpServer | HttpsServer, authenticate: (req: IncomingMessage) => T | null) {
  const sessions = new Set<Duplex>();
  const tracked = new WeakSet<Duplex>();
  const track = (socket: Duplex) => {
    sessions.add(socket);
    if (tracked.has(socket)) return;
    tracked.add(socket);
    socket.once("close", () => sessions.delete(socket));
  };
  const stash = (req: IncomingMessage, actor: T) => {
    (req as unknown as Record<string, T>)[ACTOR_KEY] = actor;
  };
  const requests = server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Internal peer calls carry their own per-boot COMMS_TOKEN and are checked
    // again by the route itself. Requiring the user credential would leak it
    // into spawned agent environments.
    if (isPublicRoute(req.method ?? "GET", url.pathname) || url.pathname.startsWith("/api/internal/")) {
      for (const handler of requests) handler(req, res);
      return;
    }
    const actor = authenticate(req);
    if (!actor) return unauthorized(res);
    stash(req, actor);
    track(req.socket);
    for (const handler of requests) handler(req, res);
  });

  const upgrades = server.listeners("upgrade") as Array<
    (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  server.removeAllListeners("upgrade");
  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    const actor = authenticate(req);
    if (!actor) {
      // Odrzucony upgrade jest niewidoczny dla klienta poza zerwanym gniazdem —
      // przeglądarka pokazuje pusty ekran i tyle. Ścieżka bez query, żeby
      // poświadczenie nie trafiło do logu.
      console.log(`[auth] upgrade odrzucony: ${new URL(req.url ?? "/", "http://127.0.0.1").pathname}`);
      return rejectUpgrade(socket);
    }
    stash(req, actor);
    track(socket);
    // Token dostępu jedzie drugim elementem subprotokołu, a przelotka ekranu
    // (`server/computer-vnc-proxy.ts`) przepisuje CAŁE nagłówki do websockify
    // w kontenerze bota. Aktor jest już rozwiązany, więc skracamy listę do
    // samego znacznika: dalej nie leci nic, czym można się zalogować.
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    if (protocols.includes("multibot-v2")) req.headers["sec-websocket-protocol"] = "multibot-v2";
    for (const handler of upgrades) handler(req, socket, head);
  });
  return {
    /** Revoking a credential closes SSE/WS and idle authenticated keep-alives.
     * Keep the revoking request's own socket alive to return its response.
     * ponytail: kills every tracked socket, not just the revoked user's —
     * everyone else reconnects on a credential that is still valid. Per-user
     * buckets when a busy server makes the reconnect storm visible. */
    revokeSessions(except?: Duplex) {
      for (const socket of sessions) if (socket !== except) socket.destroy();
    },
  };
}
