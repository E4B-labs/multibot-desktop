// multibot (0.5.0): SOCKS5 CONNECT, by hand. Forty lines of protocol beat a
// dependency here for two reasons. First, the only client is our own tor on
// 127.0.0.1, so there is no proxy zoo to be compatible with. Second, the thing
// we tunnel is a RAW TLS socket whose certificate fingerprint we compare
// ourselves (`probeRelay`) — an HTTP-level agent could not carry that at all.
//
// The address type is always DOMAIN (0x03), never IPv4/IPv6, and that is the
// security-relevant part: the `.onion` name is handed to tor as a string and is
// therefore never resolved by this machine. Nothing about the hidden service we
// dial ever reaches a DNS server.
import { connect, type Socket } from "node:net";

const VERSION = 0x05;
const NO_AUTH = 0x00;
const CONNECT = 0x01;
const DOMAIN = 0x03;

/** RFC 1928 §6. Only used to say *why* in an error a human might read. */
const REPLY: Record<number, string> = {
  1: "general failure",
  2: "connection not allowed",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** How long the whole greeting + CONNECT exchange may take. Tor answers the
 * greeting instantly but holds the CONNECT reply until the rendezvous with the
 * hidden service is built, which is the slow part of a first onion dial. */
export const SOCKS_TIMEOUT_MS = 45_000;

/**
 * Open `host:port` through the SOCKS5 proxy on `127.0.0.1:socksPort` and hand
 * back the connected socket, ready for `tls.connect({ socket })`.
 *
 * The socket is returned PAUSED: anything the peer sent glued to the CONNECT
 * reply is pushed back into it, and dropping that on the floor while the caller
 * is still attaching listeners would corrupt the very first TLS record.
 * `tls.connect({ socket })` resumes it (verified); a plain reader must call
 * `socket.resume()`.
 *
 * Rejects instead of hanging on every failure: refused proxy, refused auth
 * method, refused CONNECT, timeout, socket closed mid-handshake.
 */
export function socksConnect(
  socksPort: number,
  host: string,
  port: number,
  timeoutMs = SOCKS_TIMEOUT_MS,
): Promise<Socket> {
  const target = Buffer.from(host, "utf8");
  // The wire format carries the length in ONE byte, so anything longer cannot
  // be expressed — refuse rather than truncate into a request for a different
  // host than the caller asked for.
  if (target.length < 1 || target.length > 255) return Promise.reject(new Error("socks5: host must be 1-255 bytes"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("socks5: port out of range"));

  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: socksPort });
    socket.setTimeout(timeoutMs);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let greeted = false;
    let settled = false;

    const detach = (): void => {
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("timeout", onTimeout);
      socket.setTimeout(0);
    };
    const fail = (message: string): void => {
      if (settled) return;
      detach();
      socket.destroy();
      reject(new Error(`socks5: ${message}`));
    };
    const onError = (error: Error): void => fail(error.message);
    const onClose = (): void => fail("proxy closed the connection mid-handshake");
    const onTimeout = (): void => fail("proxy did not answer in time");

    function onData(chunk: Buffer): void {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (!greeted) {
        if (buffer.length < 2) return;
        if (buffer[0] !== VERSION) return fail(`proxy is not SOCKS5 (version 0x${buffer[0].toString(16)})`);
        // 0xFF is "no acceptable method"; anything but 0x00 means it wants
        // credentials we deliberately do not have — tor never asks for any.
        if (buffer[1] !== NO_AUTH) return fail(`proxy refused the no-auth method (0x${buffer[1].toString(16)})`);
        greeted = true;
        buffer = buffer.subarray(2);
        socket.write(Buffer.concat([
          Buffer.from([VERSION, CONNECT, 0x00, DOMAIN, target.length]),
          target,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]));
      }
      // The reply may already be in the same chunk as the greeting answer, so
      // this is not an `else`.
      if (buffer.length < 5) return;
      if (buffer[0] !== VERSION) return fail(`bad reply version 0x${buffer[0].toString(16)}`);
      if (buffer[1] !== 0x00) return fail(REPLY[buffer[1]] ?? `CONNECT refused (0x${buffer[1].toString(16)})`);
      const type = buffer[3];
      const addressBytes = type === 0x01 ? 4 : type === 0x04 ? 16 : type === DOMAIN ? 1 + buffer[4] : -1;
      if (addressBytes < 0) return fail(`bad reply address type 0x${type.toString(16)}`);
      const total = 4 + addressBytes + 2;
      if (buffer.length < total) return;

      detach();
      // Anything the peer already sent past the reply belongs to the tunnelled
      // stream (a TLS ServerHello can legitimately arrive glued to it), so it
      // goes back into the socket rather than on the floor.
      const rest = buffer.subarray(total);
      socket.pause();
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    }

    socket.on("connect", () => socket.write(Buffer.from([VERSION, 0x01, NO_AUTH])));
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("timeout", onTimeout);
  });
}
