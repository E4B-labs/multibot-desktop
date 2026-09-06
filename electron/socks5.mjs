// SOCKS5 CONNECT, hand-written (PLAN-TOR D6). A protocol that is four packets
// long does not earn an npm dependency, and no proxy-agent library would help
// the raw-TLS fingerprint probe anyway — that one needs the SOCKET, not a
// `fetch` wrapper.
//
// Domain ATYP (0x03) UNCONDITIONALLY, never "is this an IP?": the whole point
// of this file is that a `.onion` name never reaches a resolver. An ATYP chosen
// by inspecting the name would send resolution back to this machine the first
// time somebody typed an address that happens to parse as an IP.
import { connect } from "node:net";

const VERSION = 0x05;
const NO_AUTH = 0x00;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

/** RFC 1928 §6 reply codes, said in words — the number alone tells nobody why. */
const REFUSED = {
  1: "general failure",
  2: "connection not allowed",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** Marks every failure of this handshake, so callers can tell a dead tunnel
 * from a dead server. */
export const SOCKS_FAILED = "MULTIBOT_SOCKS_FAILED";

function socksError(message) {
  return Object.assign(new Error(message), { code: SOCKS_FAILED });
}

/**
 * How many bytes the reply frame occupies: 0 when it has not all arrived yet,
 * -1 when the address type is one we cannot measure (so we can never guess a
 * length and hand TLS somebody else's bytes).
 */
function replyLength(buf) {
  if (buf.length < 5) return 0;
  const atyp = buf[3];
  const address = atyp === ATYP_IPV4 ? 4 : atyp === ATYP_IPV6 ? 16 : atyp === ATYP_DOMAIN ? 1 + buf[4] : -1;
  if (address < 0) return -1;
  const total = 4 + address + 2;
  return buf.length >= total ? total : 0;
}

/**
 * Opens a tunnelled TCP connection through a SOCKS5 proxy and resolves with the
 * socket, positioned exactly after the reply frame — so the caller can start a
 * TLS handshake on it as if it had dialled the target itself.
 *
 * The returned socket is PAUSED. `tls.connect({ socket })` drains it on the
 * next tick and node's HTTP client resumes it when it attaches its parser;
 * pausing is what keeps the first bytes after the handshake from falling on the
 * floor between our listener leaving and theirs arriving.
 *
 * @returns {Promise<import("node:net").Socket>}
 */
export function socksConnect({ socksPort, host, port, socksHost = "127.0.0.1", timeoutMs = 30_000 }) {
  return new Promise((resolveWith, rejectWith) => {
    const name = Buffer.from(String(host ?? ""), "utf8");
    if (name.length < 1 || name.length > 255) {
      rejectWith(socksError("SOCKS5 target name must be 1-255 bytes"));
      return;
    }
    const targetPort = Number(port);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      rejectWith(socksError("SOCKS5 target port is out of range"));
      return;
    }
    const request = Buffer.concat([
      Buffer.from([VERSION, CMD_CONNECT, 0x00, ATYP_DOMAIN, name.length]),
      name,
      Buffer.from([targetPort >> 8, targetPort & 0xff]),
    ]);

    const socket = connect(socksPort, socksHost);
    socket.setNoDelay(true);
    let pending = Buffer.alloc(0);
    let stage = "greeting";
    let settled = false;

    const detach = () => {
      clearTimeout(budget);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      detach();
      socket.destroy();
      rejectWith(err);
    };
    const onError = (err) => fail(Object.assign(err, { code: err?.code ?? SOCKS_FAILED }));
    const onClose = () => fail(socksError("the Tor SOCKS port closed during the handshake"));

    const onData = (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (stage === "greeting") {
        if (pending.length < 2) return;
        if (pending[0] !== VERSION) return fail(socksError("that port is not a SOCKS5 proxy"));
        if (pending[1] !== NO_AUTH) return fail(socksError("the SOCKS5 proxy refused an unauthenticated connection"));
        pending = pending.subarray(2);
        stage = "reply";
        socket.write(request);
      }
      if (stage !== "reply") return;
      if (pending.length < 2) return;
      if (pending[0] !== VERSION) return fail(socksError("that port is not a SOCKS5 proxy"));
      if (pending[1] !== 0x00) return fail(socksError(`SOCKS5 refused the target: ${REFUSED[pending[1]] ?? pending[1]}`));
      const used = replyLength(pending);
      if (used === -1) return fail(socksError("SOCKS5 replied with an address type we cannot parse"));
      if (used === 0) return;
      settled = true;
      const rest = pending.subarray(used);
      // Pause BEFORE dropping our listener: removing a `data` handler does not
      // stop a flowing stream, so anything the target sent unprompted would be
      // read and thrown away before TLS ever attached.
      socket.pause();
      detach();
      if (rest.length) socket.unshift(rest);
      resolveWith(socket);
    };

    const budget = setTimeout(() => fail(socksError("the SOCKS5 handshake timed out")), timeoutMs);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("connect", () => socket.write(Buffer.from([VERSION, 0x01, NO_AUTH])));
  });
}
