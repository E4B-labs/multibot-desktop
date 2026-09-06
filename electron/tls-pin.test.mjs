// Testy przypinania certyfikatu (TOFU). Czysta funkcja, więc bez gniazd:
// reguła zaufania ma być sprawdzalna bez stawiania serwera TLS.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createSecureServer } from "node:https";

import { describe, expect, it } from "vitest";

import { probeServer } from "./host-probe.mjs";
import { CERT_CHANGED, pinRequest, verifyFingerprint } from "./tls-pin.mjs";

const FP = "AA:BB:CC:DD";

describe("tls fingerprint pin", () => {
  it("pierwszy kontakt zapamiętuje odcisk", () => {
    expect(verifyFingerprint({ stored: undefined, actual: FP })).toEqual({ learned: FP });
    expect(verifyFingerprint({ stored: "", actual: FP })).toEqual({ learned: FP });
  });

  it("ten sam certyfikat przechodzi, niezależnie od zapisu odcisku", () => {
    expect(verifyFingerprint({ stored: FP, actual: FP })).toEqual({});
    expect(verifyFingerprint({ stored: "aabbccdd", actual: FP })).toEqual({});
  });

  it("inny certyfikat to twardy błąd, nie ciche zaufanie", () => {
    expect(() => verifyFingerprint({ stored: FP, actual: "AA:BB:CC:DE" })).toThrow("server certificate changed");
    try {
      verifyFingerprint({ stored: FP, actual: "AA:BB:CC:DE" });
    } catch (err) {
      expect(err.code).toBe(CERT_CHANGED);
    }
  });

  it("brak certyfikatu też jest błędem", () => {
    expect(() => verifyFingerprint({ stored: FP, actual: undefined })).toThrow(/no certificate/);
    expect(() => verifyFingerprint({ stored: undefined, actual: "" })).toThrow(/no certificate/);
  });
});

// Samo porównanie odcisków to połowa roboty — druga to MIEJSCE, w którym się
// odpala. Atrapa gniazda sprawdza je bez sieci: przypięcie ma zerwać połączenie
// w uchwycie `secureConnect`, czyli zanim cokolwiek pójdzie na drut.
function handshake({ stored, actual }) {
  const req = new EventEmitter();
  const socket = new EventEmitter();
  socket.getPeerCertificate = () => (actual ? { fingerprint256: actual } : {});
  socket.destroy = (err) => {
    socket.killedWith = err;
  };
  const saved = [];
  pinRequest(req, { get: () => stored, set: (fp) => saved.push(fp) });
  req.emit("socket", socket);
  socket.emit("secureConnect");
  return { socket, saved };
}

describe("pinRequest", () => {
  it("zgodny certyfikat nie rusza gniazda", () => {
    expect(handshake({ stored: FP, actual: FP }).socket.killedWith).toBe(undefined);
  });

  it("niezgodny zrywa połączenie z kodem, po którym poznaje je wołający", () => {
    const { socket, saved } = handshake({ stored: FP, actual: "AA:BB:CC:DE" });
    expect(socket.killedWith?.code).toBe(CERT_CHANGED);
    expect(saved).toEqual([]);
  });

  it("pierwszy kontakt zapamiętuje odcisk i przepuszcza", () => {
    const { socket, saved } = handshake({ stored: undefined, actual: FP });
    expect(socket.killedWith).toBe(undefined);
    expect(saved).toEqual([FP]);
  });
});

// Prawdziwy uścisk dłoni z certyfikatem z własnego podpisu. Certyfikatu nie
// trzymamy w repo (klucz prywatny w gicie zostaje w historii na zawsze) — robi
// go openssl w katalogu tymczasowym, a bez openssl test się pomija.
const openssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!openssl)("przypięcie na żywym TLS", () => {
  it("zły odcisk = zero bajtów u serwera, dobry = zwykła odpowiedź", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multibot-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-nodes",
      "-subj", "/CN=MultiBot test"], { stdio: "ignore" });
    const seen = [];
    const server = createSecureServer(
      { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
      (req, res) => {
        seen.push(req.url);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ serverId: "mbs_test", configured: true }));
      },
    );
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const url = `https://127.0.0.1:${server.address().port}`;

    const wrong = await probeServer(url, { pin: { get: () => "00:11:22", set: () => {} } });
    expect(wrong).toEqual({ ok: false, error: "certificate_changed" });
    // Sedno: hasło serwera jedzie dopiero PO uścisku dłoni, więc podstawiony
    // serwer nie zobaczył ani bajtu żądania.
    expect(seen).toEqual([]);

    const first = await probeServer(url, { pin: { get: () => undefined, set: () => {} } });
    expect(first.ok).toBe(true);
    const pinned = await probeServer(url, { pin: { get: () => first.tlsFingerprint, set: () => {} } });
    expect(pinned).toEqual({ ok: true, configured: true, tlsFingerprint: first.tlsFingerprint });
    expect(seen).toEqual(["/api/public/server", "/api/public/server"]);

    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
