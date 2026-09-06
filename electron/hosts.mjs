// Remote-host registry for the Electron shell (C2). Persisted in its own
// file under userData — separate from the harness's own
// ~/.openmausbot/config.json (owned by server/config.ts).
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

import { normalizeRemoteUrl, removeRemoteHost, resolveActiveTarget, upsertRemoteHost } from "./host-resolve.mjs";

function filePath() {
  return path.join(app.getPath("userData"), "remote-hosts.json");
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), "utf8"));
  } catch {
    return { activeId: "local", hosts: [] };
  }
}

function writeRaw(config) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(config, null, 2), "utf8");
}

// Hard rule: never plaintext. Refuses to save rather than silently falling
// back to an unencrypted file when the OS has no credential store (e.g.
// Linux with no keyring) — the caller must surface this to the user.
function encryptToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("This device has no OS-level credential store available, so the token can't be saved securely.");
  }
  return safeStorage.encryptString(token).toString("base64");
}

function decryptToken(encoded) {
  return safeStorage.decryptString(Buffer.from(encoded, "base64"));
}

export function listRemoteHosts() {
  return readRaw().hosts ?? [];
}

export function getActiveId() {
  return readRaw().activeId ?? "local";
}

/** Hosts compare by origin: `https://h:8799/` and `https://h:8799` are one
 * host, and so is the same address arriving from a certificate error. */
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Czy ten adres jest w ogóle zapisanym hostem — brama dla zgody na
 * certyfikat z własnego podpisu (`certificate-error` w main.mjs). Obce originy
 * mają dostawać odmowę Chromium, a nie nasze TOFU. */
export function isKnownHost(url) {
  return (readRaw().hosts ?? []).some((h) => sameOrigin(h.url, url));
}

/** Pinned TLS fingerprint of this host, or undefined when its certificate has
 * never been seen (records saved before pinning existed have no field). */
export function getHostFingerprint(url) {
  return (readRaw().hosts ?? []).find((h) => sameOrigin(h.url, url))?.tlsFingerprint;
}

/** Remembers the certificate of a host we already know — trust on first use.
 * An unknown address is a no-op: the fingerprint travels with addRemoteHost
 * instead, right after the join handshake that observed it. */
export function setHostFingerprint(url, tlsFingerprint) {
  const config = readRaw();
  const hosts = config.hosts ?? [];
  const stale = hosts.filter((h) => sameOrigin(h.url, url) && h.tlsFingerprint !== tlsFingerprint);
  if (!stale.length) return;
  for (const host of stale) host.tlsFingerprint = tlsFingerprint;
  writeRaw({ activeId: config.activeId, hosts });
}

// The token is optional: the onboarding "connect" flow saves the address
// alone and lets the host's own LoginScreen take the token (it lands in that
// origin's localStorage, which outlives restarts and updates).
export function addRemoteHost({ name, url, token, tlsFingerprint }) {
  const config = readRaw();
  const normalized = normalizeRemoteUrl(url);
  const tokenEnc = token?.trim() ? encryptToken(token.trim()) : undefined;
  const host = {
    id: `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: (name ?? "").trim() || normalized,
    url: normalized,
    tokenEnc,
    // Optional, and only ever written for an https host — the record stays
    // readable by shells that predate pinning.
    tlsFingerprint: tlsFingerprint || undefined,
    createdAt: Date.now(),
  };
  const hosts = upsertRemoteHost(config.hosts ?? [], host);
  writeRaw({ activeId: config.activeId, hosts });
  return { id: host.id, name: host.name, url: host.url, createdAt: host.createdAt };
}

export function removeHost(id) {
  const config = readRaw();
  const hosts = removeRemoteHost(config.hosts ?? [], id);
  const activeId = config.activeId === id ? "local" : config.activeId;
  writeRaw({ activeId, hosts });
}

export function setActiveHost(id) {
  const config = readRaw();
  writeRaw({ activeId: id, hosts: config.hosts ?? [] });
}

/** Resolves what main.mjs should load: {mode:"local"} or
 * {mode:"remote", url, token, name}. Decryption happens only here, at the
 * point of use. */
export function resolveLoadTarget() {
  const resolved = resolveActiveTarget(readRaw());
  if (resolved.mode === "local") return resolved;
  const token = resolved.host.tokenEnc ? decryptToken(resolved.host.tokenEnc) : "";
  return { mode: "remote", url: resolved.host.url, token, name: resolved.host.name };
}
