// multibot: one gate for the whole harness. Public allowlist first, then the
// identity v2 credential (session cookie, access-token bearer, or the WS
// subprotocol / `?token=` the screen's websockify upgrade carries), then 401.
// There is no second rail any more: an unauthenticated caller is always 401,
// never 426.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
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

/** Mount last: wraps both the app request handler and every upgrade handler,
 * including the events and per-bot computer sockets. `authenticated` is the
 * identity check — it already reads the cookie, the bearer, the `multibot-v2`
 * subprotocol and the screen's `?token=`. */
export function mountAuth(server: Server, authenticated: (req: IncomingMessage) => boolean) {
  const sessions = new Set<Duplex>();
  const tracked = new WeakSet<Duplex>();
  const track = (socket: Duplex) => {
    sessions.add(socket);
    if (tracked.has(socket)) return;
    tracked.add(socket);
    socket.once("close", () => sessions.delete(socket));
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
    if (!authenticated(req)) return unauthorized(res);
    req.headers["x-multibot-auth"] = "session";
    track(req.socket);
    for (const handler of requests) handler(req, res);
  });

  const upgrades = server.listeners("upgrade") as Array<
    (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  server.removeAllListeners("upgrade");
  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    if (!authenticated(req)) {
      // Odrzucony upgrade jest niewidoczny dla klienta poza zerwanym gniazdem —
      // przeglądarka pokazuje pusty ekran i tyle. Ścieżka bez query, żeby
      // poświadczenie nie trafiło do logu.
      console.log(`[auth] upgrade odrzucony: ${new URL(req.url ?? "/", "http://127.0.0.1").pathname}`);
      return rejectUpgrade(socket);
    }
    req.headers["x-multibot-auth"] = "session";
    track(socket);
    // Nagłówka NIE przepisujemy: siedzi w nim token dostępu, a `/api/events`
    // rozwiązuje aktora leniwie, przy KAŻDEJ ramce (filtr ACL). Skrócenie go do
    // samego znacznika kasowało poświadczenie i socket przestawał widzieć boty.
    // `server/events-ws.ts` odsyła i tak tylko pierwszy element listy.
    for (const handler of upgrades) handler(req, socket, head);
  });
  return {
    /** Revoking a credential closes SSE/WS and idle authenticated keep-alives.
     * Keep the revoking request's own socket alive to return its response. */
    revokeSessions(except?: Duplex) {
      for (const socket of sessions) if (socket !== except) socket.destroy();
    },
  };
}
