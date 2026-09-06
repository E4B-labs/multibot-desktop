// Certyfikat kodujemy sami w DER, więc dowodem, że wyszedł poprawny, jest
// wyłącznie to, co powie o nim KTOŚ INNY: parser X.509 Node'a i prawdziwy
// uścisk dłoni TLS. Stąd żadnych asercji na bajty — same obserwacje z zewnątrz.
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createSecureContext, createServer, type Server } from "node:tls";
import { describe, expect, it } from "vitest";

import { candidateIps, ensureTlsMaterial, generateSelfSigned, ipBytes } from "./tls-cert.ts";

const material = (ips: string[]) => generateSelfSigned({ ips, dnsNames: ["localhost"], commonName: "MultiBot test", days: 3650 });

describe("generateSelfSigned", () => {
  it("wystawia certyfikat, który parser X.509 przyjmuje", () => {
    const { certPem, fingerprint256 } = material(["127.0.0.1", "::1", "192.168.1.7"]);
    const cert = new X509Certificate(certPem);
    expect(cert.subject).toBe("CN=MultiBot test");
    expect(cert.issuer).toBe(cert.subject); // self-signed: wystawca to my sami
    // Podpis MUSI zgadzać się z własnym kluczem publicznym — bez tego ręczna
    // serializacja DER jest tylko ładnie wyglądającym śmieciem.
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.ca).toBe(false);
    expect(cert.fingerprint256).toBe(fingerprint256);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now() + 9 * 365 * 86_400_000);
    expect(new Date(cert.validFrom).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("wpisuje do SAN wszystkie adresy i nazwy", () => {
    const cert = new X509Certificate(material(["127.0.0.1", "::1", "192.168.1.7"]).certPem);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("IP Address:192.168.1.7");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(cert.checkIP("192.168.1.7")).toBe("192.168.1.7");
    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(cert.checkIP("::1")).toBeTruthy();
    expect(cert.checkIP("10.9.9.9")).toBeUndefined();
    expect(cert.checkHost("localhost")).toBe("localhost");
  });

  it("działa jako materiał serwera TLS i daje ten sam odcisk w uścisku dłoni", async () => {
    const { keyPem, certPem, fingerprint256 } = material(["127.0.0.1"]);
    const server: Server = createServer({ key: keyPem, cert: certPem }, (socket) => socket.end("ok"));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    try {
      const seen = await new Promise<string>((done, fail) => {
        const socket = connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
          done(socket.getPeerCertificate().fingerprint256);
          socket.destroy();
        });
        socket.on("error", fail);
      });
      expect(seen).toBe(fingerprint256);
    } finally {
      server.close();
    }
  });
});

describe("ipBytes", () => {
  it("koduje IPv4 i IPv6 tak, jak chce SAN", () => {
    expect(ipBytes("127.0.0.1")?.toString("hex")).toBe("7f000001");
    expect(ipBytes("::1")?.toString("hex")).toBe("00000000000000000000000000000001");
    expect(ipBytes("fe80::1%eth0")?.toString("hex")).toBe("fe800000000000000000000000000001");
    expect(ipBytes("::ffff:1.2.3.4")?.toString("hex")).toBe("00000000000000000000ffff01020304");
    expect(ipBytes("2001:db8:0:0:0:0:0:1")?.toString("hex")).toBe("20010db8000000000000000000000001");
    expect(ipBytes("nie-adres")).toBeNull();
  });
});

describe("candidateIps", () => {
  it("zawsze zawiera pętlę zwrotną", () => {
    expect(candidateIps()).toEqual(expect.arrayContaining(["127.0.0.1", "::1"]));
  });

  // Adres, pod którym i tak nikt nie zawoła serwera, w SAN-ie tylko zajmuje
  // miejsce (link-local bez strefy jest bezużyteczny, Teredo rotuje).
  it("pomija adresy link-local i Teredo", () => {
    expect(candidateIps().some((ip) => /^(fe80:|169\.254\.|2001:0:)/i.test(ip))).toBe(false);
  });
});

describe("ensureTlsMaterial", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "omb-tls-"));

  it("wystawia materiał przy pierwszym boocie i zapisuje klucz prywatnie", () => {
    const dataDir = dir();
    const first = ensureTlsMaterial(dataDir, { ips: ["127.0.0.1"] });
    expect(readFileSync(join(dataDir, "tls.crt"), "utf8")).toBe(first.certPem);
    expect(new X509Certificate(first.certPem).fingerprint256).toBe(first.fingerprint256);
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, "tls.key")).mode & 0o777).toBe(0o600);
    }
  });

  it("przy kolejnym boocie wczytuje ten sam certyfikat", () => {
    const dataDir = dir();
    const first = ensureTlsMaterial(dataDir, { ips: ["127.0.0.1"] });
    expect(ensureTlsMaterial(dataDir, { ips: ["127.0.0.1"] }).fingerprint256).toBe(first.fingerprint256);
  });

  // Adresy tej maszyny zmieniają się same (DHCP, VPN, docker0, tymczasowe
  // IPv6). Gdyby to wymieniało certyfikat, każdy przypięty klient dostawałby
  // „server certificate changed" po przesiadce na inne Wi-Fi.
  it("NIE wymienia certyfikatu, gdy przybył adres spoza SAN-u", () => {
    const dataDir = dir();
    const first = ensureTlsMaterial(dataDir, { ips: ["127.0.0.1"] });
    const second = ensureTlsMaterial(dataDir, { ips: ["127.0.0.1", "10.0.0.5"] });
    expect(second.fingerprint256).toBe(first.fingerprint256);
    expect(new X509Certificate(second.certPem).checkIP("10.0.0.5")).toBeUndefined();
  });

  it("wymienia materiał, którego nie da się złożyć w kontekst TLS", () => {
    const dataDir = dir();
    const first = ensureTlsMaterial(dataDir, { ips: ["127.0.0.1"] });
    // Klucz od innego certyfikatu: pliki się parsują, ale pary z nich nie ma.
    writeFileSync(join(dataDir, "tls.key"), generateSelfSigned({ ips: ["127.0.0.1"], dnsNames: [], commonName: "obcy", days: 1 }).keyPem);
    const healed = ensureTlsMaterial(dataDir, { ips: ["127.0.0.1"] });
    expect(healed.fingerprint256).not.toBe(first.fingerprint256);
    createSecureContext({ key: healed.keyPem, cert: healed.certPem }); // rzuca, gdy para nie pasuje
  });
});
