// Remote-host registry for the Electron shell (C2). Persisted in its own
// file under userData — separate from the harness's own
// ~/.openmausbot/config.json (owned by server/config.ts).
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

import { mergeRemoteHost, normalizeRemoteUrl, removeRemoteHost, resolveActiveTarget, sameOrigin } from "./host-resolve.mjs";

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
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Przez plik tymczasowy i `rename`: przerwany zapis w miejscu zostawiłby
  // urwany JSON, a `readRaw` czyta go jako „brak hostów" — czyli cicha utrata
  // wszystkich adresów i przypiętych odcisków.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, file);
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

/** Pinned TLS fingerprint of this host, or undefined when its certificate has
 * never been seen (records saved before pinning existed have no field). */
export function getHostFingerprint(url) {
  return (readRaw().hosts ?? []).find((h) => sameOrigin(h.url, url))?.tlsFingerprint;
}

/** Remembers the certificate of a host we already know — trust on FIRST use
 * only. Nigdy nie nadpisuje przypiętego odcisku: podmiana certyfikatu ma być
 * twardym błędem, a nie cichym „no dobrze, teraz ufamy temu". Zapomnienie
 * przypięcia jest osobną, jawną decyzją (`forgetHostFingerprint`).
 * An unknown address is a no-op: the fingerprint travels with addRemoteHost
 * instead, right after the join handshake that observed it. */
export function setHostFingerprint(url, tlsFingerprint) {
  const config = readRaw();
  const hosts = config.hosts ?? [];
  const fresh = hosts.filter((h) => sameOrigin(h.url, url) && !h.tlsFingerprint);
  if (!fresh.length || !tlsFingerprint) return;
  for (const host of fresh) host.tlsFingerprint = tlsFingerprint;
  writeRaw({ activeId: config.activeId, hosts });
}

/** Wyrzuca przypięcie, żeby następne połączenie zaufało od nowa. Jedyna droga
 * po tym, jak serwer wystawił sobie nowy certyfikat — decyzja użytkownika, nie
 * cicha zgoda kodu. */
export function forgetHostFingerprint(url) {
  const config = readRaw();
  const hosts = config.hosts ?? [];
  const pinned = hosts.filter((h) => sameOrigin(h.url, url) && h.tlsFingerprint);
  if (!pinned.length) return false;
  for (const host of pinned) delete host.tlsFingerprint;
  writeRaw({ activeId: config.activeId, hosts });
  return true;
}

// The token is optional: the onboarding "connect" flow saves the address
// alone and lets the host's own LoginScreen take the token (it lands in that
// origin's localStorage, which outlives restarts and updates).
export function addRemoteHost({ name, url, token, tlsFingerprint, assumeHttps = false }) {
  const config = readRaw();
  const normalized = normalizeRemoteUrl(url, { assumeHttps });
  const tokenEnc = token?.trim() ? encryptToken(token.trim()) : undefined;
  const host = {
    id: `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: (name ?? "").trim(),
    url: normalized,
    tokenEnc,
    // Optional, and only ever written for an https host — the record stays
    // readable by shells that predate pinning.
    tlsFingerprint: tlsFingerprint || undefined,
    createdAt: Date.now(),
  };
  // Jeden rekord na serwer, z przejęciem tego, czego nowy wpis nie przyniósł —
  // reguła siedzi w host-resolve.mjs, żeby dało się ją sprawdzić testem.
  const hosts = mergeRemoteHost(config.hosts ?? [], host);
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
