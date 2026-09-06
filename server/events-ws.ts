// multibot: kanał zdarzeń po WebSocket, równoległy do SSE na tej samej ścieżce.
//
// Dlaczego w ogóle: szybki tunel Cloudflare (`cloudflared tunnel --url`) buforuje
// odpowiedź strumieniową do samego końca — `/api/events` po SSE nie dowozi ani
// jednego bajtu, dopóki serwer nie zamknie odpowiedzi (zmierzone: strumień
// kończący się po 5 s przychodzi w całości na 5 s, strumień nieskończony milczy
// w nieskończoność, także po 100 KB wypełniacza i z `no-transform`). Upgrade do
// WebSocketa ten sam tunel przepuszcza w czasie rzeczywistym. Bez WS zdalna apka
// nigdy nie dostaje `message`, więc dymek użytkownika zostaje szary na zawsze.
//
// Bramka autoryzacji jest jedna — `mountAuth` opakowuje listener `upgrade`, więc
// ten moduł montujemy PRZED nim (jak `mountVncUpgrade`).
import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
type EventFilter = (text: string) => boolean;
type Client = { socket: Duplex; filter: EventFilter };
const clients = new Set<Client>();

/** Ramka serwer→klient jest niemaskowana (RFC 6455 §5.1). */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Klient (przeglądarka) mówi tylko pingiem albo close'em — tyle nas obchodzi. */
function readClientFrames(socket: Duplex): (chunk: Buffer) => void {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (mask) {
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4];
        payload = copy;
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) return void socket.destroy();
      if (opcode === 0x9) socket.write(frame(0xa, payload.subarray(0, 125)));
    }
  };
}

/** Rozsyła jedną gotową linijkę JSON-a do wszystkich klientów WS. */
export function broadcastWs(text: string): void {
  if (!clients.size) return;
  const data = frame(0x1, Buffer.from(text, "utf8"));
  for (const client of [...clients]) {
    if (!client.filter(text)) continue;
    const socket = client.socket;
    try {
      socket.write(data);
    } catch {
      clients.delete(client);
      socket.destroy();
    }
  }
}

export function eventsWsClientCount(): number {
  return clients.size;
}

/** Montuje upgrade `/api/events`. `onOpen` dostaje URL (parametry jak w SSE)
 *  i nadajnik pierwszej ramki. */
export function mountEventsWs(
  server: HttpServer | HttpsServer,
  onOpen: (url: URL, send: (text: string) => void, req: IncomingMessage) => EventFilter | void,
): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/events") return;
    void head;
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") return void socket.destroy();
    // `mountAuth` zostawia w nagłówku sam znacznik, bez tokenu — odsyłamy go,
    // bo przeglądarka zrywa połączenie, gdy zaproponowany subprotokół zniknie.
    const protocol = String(req.headers["sec-websocket-protocol"] ?? "").split(",")[0].trim();
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n` +
        (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : "") +
        "\r\n",
    );
    (socket as { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
    const filter = onOpen(url, (text) => socket.write(frame(0x1, Buffer.from(text, "utf8"))), req) ?? (() => true);
    const client = { socket, filter };
    clients.add(client);
    // Ping co 25 s: ten sam odstęp co keepalive SSE, trzyma tunel przy życiu.
    const keepalive = setInterval(() => {
      try {
        socket.write(frame(0x9, Buffer.alloc(0)));
      } catch {
        socket.destroy();
      }
    }, 25_000);
    keepalive.unref?.();
    socket.on("data", readClientFrames(socket));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearInterval(keepalive);
      clients.delete(client);
    });
  });
}
