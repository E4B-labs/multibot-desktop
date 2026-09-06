// TOFU (trust-on-first-use) certificate pinning for MultiBot servers. From
// 0.4.0 a server serves a self-signed certificate by design (server/tls-cert.ts):
// there is no CA to ask, so trust is "the same certificate as last time",
// exactly like SSH's known_hosts. A changed certificate is a hard error, never
// a silent re-trust.
//
// MEASURED, and the reason this file exists at all: with a self-signed
// certificate node NEVER calls `checkServerIdentity`. Chain verification fails
// first (DEPTH_ZERO_SELF_SIGNED_CERT) and `rejectUnauthorized:false` swallows
// that failure, so `checkServerIdentity` is skipped entirely — a pin written
// there would accept every certificate in silence. The handshake has to be
// inspected on the socket instead ('secureConnect'), where destroying the
// socket still happens BEFORE a single request byte (the server password!)
// reaches the wire — also measured.
import { X509Certificate } from "node:crypto";

/** Marks both pin failures, so callers can tell them from a dead network. */
export const CERT_CHANGED = "MULTIBOT_CERT_CHANGED";

/** "aa:BB:cc" and "AABBCC" are the same fingerprint. */
function canonical(fingerprint) {
  return String(fingerprint ?? "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
}

/**
 * Pure pin decision, so the rule is testable without a socket.
 * `learned` is set on first contact — the caller persists it.
 */
export function verifyFingerprint({ stored, actual }) {
  const seen = canonical(actual);
  if (!seen) throw Object.assign(new Error("server presented no certificate"), { code: CERT_CHANGED });
  const known = canonical(stored);
  if (!known) return { learned: String(actual) };
  if (known !== seen) throw Object.assign(new Error("server certificate changed"), { code: CERT_CHANGED });
  return {};
}

/** SHA-256 of a PEM certificate in node's `AA:BB:…` shape — Electron hands
 * `certificate-error` the PEM, node sockets hand out the fingerprint. */
export function fingerprintOfPem(pem) {
  return new X509Certificate(pem).fingerprint256;
}

/**
 * Applies the pin to an outgoing http(s) request. No-op on plain http: no
 * handshake, so no 'secureConnect' — pre-0.4.0 hosts keep working unpinned.
 * @param {import("node:http").ClientRequest} req
 * @param {{ get: () => string | undefined, set: (fingerprint: string) => void }} pin
 */
export function pinRequest(req, pin) {
  req.on("socket", (socket) => {
    socket.on("secureConnect", () => {
      try {
        const actual = socket.getPeerCertificate?.()?.fingerprint256;
        // A resumed session may carry no certificate copy — it was pinned when
        // the session was created, so there is nothing new to check.
        if (!actual && socket.isSessionReused?.()) return;
        const { learned } = verifyFingerprint({ stored: pin.get(), actual });
        if (learned) {
          // Nieudany zapis (dysk, uprawnienia) nie ma prawa zerwać połączenia,
          // które właśnie przeszło sprawdzenie — najwyżej odcisk zostanie
          // zapamiętany przy następnym uścisku dłoni.
          try {
            pin.set(learned);
          } catch {
            /* nic — patrz wyżej */
          }
        }
      } catch (err) {
        socket.destroy(err);
      }
    });
  });
  return req;
}
