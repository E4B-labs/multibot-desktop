// No tor binary is spawned here: the parts worth pinning are the ones that
// decide what tor is told (torrc), what we believe it said (stdout), and what
// the rest of the harness concludes from a connection that arrived over the
// onion (the ingress port and the rate-limit bucket).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";

import { rateLimitAddress } from "./identity.ts";
import { ensureTlsMaterial } from "./tls-cert.ts";
import {
  findTorBinary,
  mountTorIngress,
  parseBootstrap,
  parseSocksPort,
  onionSuppressed,
  torEnabled,
  torPath,
  torrcText,
  TOR_BUCKET,
  TOR_INGRESS_PORT,
} from "./tor.ts";

describe("torrc", () => {
  const torrc = torrcText("/home/u/.openmausbot/tor");

  it("points the hidden service at the ingress port, not at the harness port", () => {
    expect(torrc).toContain("HiddenServicePort 8799 127.0.0.1:8798");
    expect(TOR_INGRESS_PORT).toBe(8798);
  });

  it("asks for a v3 service, an automatic SOCKS port and notices on stdout", () => {
    expect(torrc).toContain("HiddenServiceVersion 3");
    expect(torrc).toContain("SocksPort auto");
    expect(torrc).toContain("Log notice stdout");
    expect(torrc).toContain("SafeLogging 1");
  });

  // A Windows data directory is `C:\Users\Jan Kowalski\…` more often than not,
  // and an unquoted space would silently turn one option into two.
  it("quotes and escapes the data directory, spaces and backslashes included", () => {
    const windows = torrcText("C:\\Users\\Jan Kowalski\\.openmausbot\\tor");
    expect(windows).toContain('DataDirectory "C:\\\\Users\\\\Jan Kowalski\\\\.openmausbot\\\\tor"');
    expect(torPath('a"b')).toBe('"a\\"b"');
  });

  // A path holding a newline could otherwise append whole config lines of the
  // attacker's choosing — a SOCKS port on 0.0.0.0, say.
  it("refuses a path with a newline instead of writing a torrc it cannot control", () => {
    expect(() => torrcText("/tmp/x\nSocksPort 0.0.0.0:9050\n")).toThrow(/newline/);
  });
});

describe("tor stdout", () => {
  it("reads the SOCKS port off both log spellings", () => {
    expect(parseSocksPort("Sep 06 22:00:00.000 [notice] Opened Socks listener on 127.0.0.1:39471")).toBe(39_471);
    expect(parseSocksPort("Sep 06 22:00:00.000 [notice] Opened Socks listener connection (ready) on 127.0.0.1:9050")).toBe(9_050);
  });

  it("ignores a listener that is not ours and lines that are not about one", () => {
    // A control or DNS listener on the same log must not be mistaken for SOCKS.
    expect(parseSocksPort("[notice] Opened Control listener on 127.0.0.1:9051")).toBeNull();
    expect(parseSocksPort("[notice] Opened Socks listener on 10.0.0.5:9050")).toBeNull();
    expect(parseSocksPort("[notice] Bootstrapped 45% (requesting_descriptors)")).toBeNull();
    expect(parseSocksPort("")).toBeNull();
  });

  it("reads the bootstrap percentage", () => {
    expect(parseBootstrap("Sep 06 22:00:05.000 [notice] Bootstrapped 100% (done): Done")).toBe(100);
    expect(parseBootstrap("[notice] Bootstrapped 5% (conn): Connecting to a relay")).toBe(5);
    expect(parseBootstrap("[notice] Opened Socks listener on 127.0.0.1:39471")).toBeNull();
  });
});

describe("rateLimitAddress", () => {
  // The whole reason the onion gets a port of its own. Every Tor client arrives
  // from 127.0.0.1, and the loopback branch below trusts `x-forwarded-for` —
  // so without this the header would let a client pick its own bucket and buy
  // unlimited scrypt guesses at the server password.
  it("puts every Tor client in one bucket and does not read x-forwarded-for", () => {
    const viaTor = { localPort: TOR_INGRESS_PORT, remoteAddress: "127.0.0.1" };
    expect(rateLimitAddress(viaTor, undefined)).toBe(TOR_BUCKET);
    expect(rateLimitAddress(viaTor, "8.8.8.8")).toBe(TOR_BUCKET);
    expect(rateLimitAddress(viaTor, ["1.1.1.1, 2.2.2.2"])).toBe(TOR_BUCKET);
    expect(rateLimitAddress({ localPort: TOR_INGRESS_PORT, remoteAddress: "::1" }, "9.9.9.9")).toBe(TOR_BUCKET);
  });

  it("still honours a reverse proxy's first hop on the normal port", () => {
    expect(rateLimitAddress({ localPort: 8799, remoteAddress: "127.0.0.1" }, "8.8.8.8, 9.9.9.9")).toBe("8.8.8.8");
  });

  it("never lets a remote peer name its own bucket", () => {
    expect(rateLimitAddress({ localPort: 8799, remoteAddress: "8.8.8.8" }, "1.2.3.4")).toBe("8.8.8.8");
    expect(rateLimitAddress({ localPort: 8799 }, "1.2.3.4")).toBe("unknown");
  });
});

describe("torEnabled", () => {
  it("is on unless the owner says otherwise", () => {
    expect(torEnabled({})).toBe(true);
    expect(torEnabled({ OMB_TOR: "1" })).toBe(true);
    for (const value of ["0", "off", "false", "no", " OFF "]) expect(torEnabled({ OMB_TOR: value })).toBe(false);
  });
});

describe("findTorBinary", () => {
  it("answers null instead of throwing when there is no tor anywhere", () => {
    expect(findTorBinary({ PATH: "" }, "linux")).toBeNull();
  });

  it("prefers OMB_TOR_BIN when it points at a real file", () => {
    // This test file itself is the one path we know exists.
    const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    expect(findTorBinary({ OMB_TOR_BIN: self, PATH: "" }, "linux")).toBe(self);
  });
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

// `server.emit("connection", socket)` on a server that is not listening itself
// is documented but uncommon, and the security story of the whole PR rests on
// `localPort` reading the ingress port afterwards.
describe("mountTorIngress", () => {
  it("hands the connection to the harness, which sees it on the ingress port", async () => {
    let seen: number | undefined;
    const harness = createServer((req, res) => {
      seen = req.socket.localPort;
      res.writeHead(200).end("ok");
    });
    servers.push(harness);
    const ingress = mountTorIngress(harness, 0);
    await new Promise((resolve) => ingress.once("listening", resolve));
    const port = (ingress.address() as { port: number }).port;

    const body = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    ingress.close();
    expect(body).toContain("200");
    expect(seen).toBe(port);
  });

  // The real harness is an `https.Server`, so `req.socket` is a TLSSocket that
  // merely wraps the accepted one. Every gate in this PR — the rate-limit
  // bucket, `isLoopbackRequest` — reads `localPort` off THAT object, so if it
  // did not carry the ingress port the whole design would fail open.
  it("carries the ingress port through TLS, where every gate reads it", async () => {
    const material = ensureTlsMaterial(mkdtempSync(join(tmpdir(), "mb-tor-tls-")));
    let seen: number | undefined;
    const harness = createTlsServer({ key: material.keyPem, cert: material.certPem }, (socket) => {
      seen = socket.localPort;
      socket.end();
    });
    const ingress = mountTorIngress(harness, 0);
    await new Promise((resolve) => ingress.once("listening", resolve));
    const port = (ingress.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => socket.end());
      socket.on("close", () => resolve());
      socket.on("error", reject);
    });
    ingress.close();
    harness.close();
    expect(seen).toBe(port);
  });
});

// Publishing an onion takes a deployment off the loopback and puts it on the
// internet. Two of them chose to be private and must never be published.
describe("onionSuppressed", () => {
  it("says yes only for a server that is meant to be reachable", () => {
    expect(onionSuppressed(false, false)).toBeNull();
  });

  it("refuses a loopback-only server — that install was deliberately private", () => {
    expect(onionSuppressed(true, false)).toMatch(/loopback/);
    expect(onionSuppressed(true, true)).toMatch(/loopback/);
  });

  // No certificate means no fingerprint, so `probeOnion` could never confirm
  // the onion — and it would still outrank every unverified rung. It would also
  // walk straight past the reverse proxy that OMB_TLS=off exists for.
  it("refuses OMB_TLS=off, where the onion could never be verified", () => {
    expect(onionSuppressed(false, true)).toMatch(/OMB_TLS=off/);
  });
});
