// multibot (0.4.0): certyfikat serwera z WŁASNYM podpisem, bez zależności.
//
// Od 0.4.0 harness słucha wyłącznie po TLS, a serwer stoi na adresie IP w
// czyjejś sieci domowej — nie ma urzędu, który by taki adres podpisał, i nie
// ma czym go poprosić. Dlatego serwer wystawia certyfikat sam, a zaufanie jest
// jak w SSH: odcisk SHA-256 zapamiętany przy pierwszym połączeniu (TOFU),
// zmiana odcisku = twardy błąd (patrz electron/tls-pin.mjs).
//
// Dlaczego DER ręcznie: Node nie ma API do WYSTAWIANIA certyfikatów (umie je
// tylko czytać), `openssl` nie istnieje ani na Termuxie, ani na Windowsie, a
// spakowany desktop nie wozi `node_modules` (electron-builder.yml) — więc
// biblioteka odpada. Zostaje ~150 linii kodowania DER na `node:crypto`.
import { execFileSync } from "node:child_process";
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";
import { createSecureContext } from "node:tls";
import { join } from "node:path";

// ——— minimalny DER ———
function der(tag: number, body: Buffer): Buffer {
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const bytes: number[] = [];
  for (let value = body.length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), body]);
}
const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts));
/** INTEGER jest ZE ZNAKIEM i MINIMALNY: wiodące zera lecą (chyba że kolejny
 * bajt ma ustawiony najstarszy bit i zero jest jedynym znakiem dodatniości),
 * a bajt z tym bitem dostaje zero z przodu. */
const int = (value: Buffer | number): Buffer => {
  let raw = typeof value === "number" ? Buffer.from([value]) : value;
  let i = 0;
  while (i + 1 < raw.length && raw[i] === 0 && !(raw[i + 1] & 0x80)) i++;
  raw = raw.subarray(i);
  return der(0x02, raw[0] & 0x80 ? Buffer.concat([Buffer.from([0]), raw]) : raw);
};
const bool = (value: boolean): Buffer => der(0x01, Buffer.from([value ? 0xff : 0x00]));
const octstr = (body: Buffer): Buffer => der(0x04, body);
const bitstr = (body: Buffer, unusedBits = 0): Buffer => der(0x03, Buffer.concat([Buffer.from([unusedBits]), body]));
const utf8 = (text: string): Buffer => der(0x0c, Buffer.from(text, "utf8"));
const ctx = (index: number, body: Buffer): Buffer => der(0xa0 | index, body);
function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = part >>> 7; rest > 0; rest >>>= 7) chunk.unshift(0x80 | (rest & 0x7f));
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}
/** RFC 5280: do 2049 włącznie UTCTime, od 2050 GeneralizedTime. */
function utc(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return year < 2050 ? der(0x17, Buffer.from(`${pad(year % 100)}${rest}`)) : der(0x18, Buffer.from(`${year}${rest}`));
}
const pem = (label: string, body: Buffer): string =>
  `-----BEGIN ${label}-----\n${(body.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;

/** Adres IP na surowe bajty SAN-u (4 albo 16). `null` = to nie jest adres. */
export function ipBytes(address: string): Buffer | null {
  const bare = address.replace(/%.*$/, ""); // fe80::1%eth0 — strefa nie jest częścią adresu
  if (isIPv4(bare)) return Buffer.from(bare.split(".").map(Number));
  if (!isIPv6(bare)) return null;
  const [headText, tailText = ""] = bare.split("::");
  let head = headText ? headText.split(":") : [];
  let tail = tailText ? tailText.split(":") : [];
  // ::ffff:1.2.3.4 — ostatnia grupa bywa zapisana po czwórkowemu
  const groups = tail.length ? tail : head;
  const last = groups[groups.length - 1];
  if (last?.includes(".")) {
    const v4 = Buffer.from(last.split(".").map(Number));
    const words = [v4.readUInt16BE(0).toString(16), v4.readUInt16BE(2).toString(16)];
    if (tail.length) tail = [...tail.slice(0, -1), ...words];
    else head = [...head.slice(0, -1), ...words];
  }
  const zeros = bare.includes("::") ? 8 - head.length - tail.length : 0;
  if (zeros < 0 || head.length + zeros + tail.length !== 8) return null;
  const out = Buffer.alloc(16);
  [...head, ...Array<string>(zeros).fill("0"), ...tail].forEach((word, i) => out.writeUInt16BE(parseInt(word, 16), i * 2));
  return out;
}

const name = (commonName: string): Buffer => seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octstr(value));

export interface TlsMaterial {
  keyPem: string;
  certPem: string;
  fingerprint256: string;
}

/**
 * Certyfikat v3 z własnym podpisem na kluczu P-256. SAN dostaje wszystkie
 * podane adresy IP i nazwy — bez SAN-u ŻADEN dzisiejszy klient certyfikatu nie
 * przyjmie (CN nie liczy się od lat).
 */
export function generateSelfSigned({
  ips,
  dnsNames,
  commonName,
  days,
}: {
  ips: string[];
  dnsNames: string[];
  commonName: string;
  days: number;
}): TlsMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecdsaWithSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const now = Date.now();
  const subjectAltName = seq(
    ...dnsNames.map((dns) => der(0x82, Buffer.from(dns, "ascii"))),
    ...ips.map(ipBytes).filter((bytes): bytes is Buffer => bytes !== null).map((bytes) => der(0x87, bytes)),
  );
  const tbs = seq(
    ctx(0, int(2)), // v3
    int(randomBytes(16)),
    ecdsaWithSha256,
    name(commonName), // issuer === subject: podpisujemy sami siebie
    // minuta wstecz: zegar świeżo postawionego telefonu bywa przed naszym
    seq(utc(new Date(now - 60_000)), utc(new Date(now + days * 86_400_000))),
    name(commonName),
    publicKey.export({ type: "spki", format: "der" }),
    ctx(
      3,
      seq(
        extension("2.5.29.17", false, subjectAltName),
        extension("2.5.29.19", true, seq()), // basicConstraints: CA:false (domyślne)
        // digitalSignature i tyle: ECDSA nie szyfruje kluczy, więc
        // keyEncipherment byłoby deklaracją nieprawdy.
        extension("2.5.29.15", true, bitstr(Buffer.from([0x80]), 7)),
        extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage: serverAuth
      ),
    ),
  );
  // `crypto.sign` dla EC oddaje podpis już w DER — dokładnie to, co wchodzi do
  // BIT STRING certyfikatu.
  const certPem = pem("CERTIFICATE", seq(tbs, ecdsaWithSha256, bitstr(sign("sha256", tbs, privateKey))));
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certPem,
    fingerprint256: new X509Certificate(certPem).fingerprint256,
  };
}

/** Adresy, których nikt nie wpisze jako adresu serwera — do SAN-u nie wnoszą
 * nic poza długością:
 *  - `fe80::/10` i `169.254/16` — link-local, bez identyfikatora strefy nie da
 *    się z nich skorzystać, a `X509_check_ip` strefy nie zna;
 *  - `2001:0::/32` — Teredo, pseudoadres do przebijania NAT-u; MEASURED na
 *    Windowsie zmienił się między dwoma startami w odstępie kilku minut. */
const VOLATILE_ADDRESS = /^(fe80:|169\.254\.|2001:0:)/i;

/** Adresy, pod którymi ten serwer może być wołany w chwili WYSTAWIANIA
 * certyfikatu: wszystkie zewnętrzne interfejsy + loopback. */
export function candidateIps(): string[] {
  const ips = new Set(["127.0.0.1", "::1"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      const address = iface.address.replace(/%.*$/, "");
      if (!iface.internal && !VOLATILE_ADDRESS.test(address)) ips.add(address);
    }
  }
  return [...ips];
}

/** Klucz prywatny ma być czytelny TYLKO dla właściciela. Na Windowsie `chmod`
 * niczego nie robi (`fs.chmodSync` ustawia tam wyłącznie bit tylko-do-odczytu),
 * więc prawa nadaje `icacls`: zerwane dziedziczenie i pełny dostęp dla tego
 * jednego konta. Nieudane nadanie nie zatrzymuje serwera — ma być głośne. */
function restrictKeyFile(keyPath: string): void {
  if (process.platform !== "win32") {
    chmodSync(keyPath, 0o600); // istniejący plik zachowałby stare prawa
    return;
  }
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [keyPath, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch (error) {
    console.warn(`[multibot] nie udało się ograniczyć praw do ${keyPath}: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Materiał TLS z `DATA_DIR`: wczytany, a gdy go nie ma, nie da się go wczytać
 * albo stracił ważność — wystawiony na nowo. 10 lat, bo odnowienie znaczy dla
 * klientów to samo co podmiana certyfikatu.
 *
 * Zbiór adresów NIE jest powodem do wymiany: DHCP, VPN, docker0 i tymczasowe
 * adresy IPv6 rotują same, a przypięty klient patrzy na odcisk, nie na SAN.
 * ponytail: przeglądarka wpuszczona na adres spoza SAN-u pokaże ostrzeżenie o
 * niezgodnej nazwie — to samo okno, które i tak pokazuje dla certyfikatu z
 * własnym podpisem. Kto chce nowy certyfikat: skasować `tls.key` i `tls.crt`.
 */
export function ensureTlsMaterial(dataDir: string, { ips = candidateIps() }: { ips?: string[] } = {}): TlsMaterial {
  const keyPath = join(dataDir, "tls.key");
  const certPath = join(dataDir, "tls.crt");
  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      const keyPem = readFileSync(keyPath, "utf8");
      const certPem = readFileSync(certPath, "utf8");
      const cert = new X509Certificate(certPem);
      // Para musi się nie tylko parsować, ale i ZŁOŻYĆ w kontekst TLS —
      // inaczej `https.createServer` wywala się przy starcie i serwer wpada w
      // pętlę restartów, której nikt nie umie odczytać.
      createSecureContext({ key: keyPem, cert: certPem });
      if (new Date(cert.validTo).getTime() > Date.now()) {
        return { keyPem, certPem, fingerprint256: cert.fingerprint256 };
      }
    } catch {
      /* nieczytelny albo niezłożony materiał = brak materiału */
    }
  }
  const fresh = generateSelfSigned({ ips, dnsNames: ["localhost"], commonName: "MultiBot server", days: 3650 });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(keyPath, fresh.keyPem, { mode: 0o600 });
  restrictKeyFile(keyPath);
  writeFileSync(certPath, fresh.certPem, { mode: 0o644 });
  return fresh;
}
