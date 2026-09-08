// "Remember login" for the Electron shell: the five values that let one tap put
// somebody back on their server — address, server name, server password,
// profile name, profile password. They live in their own file under userData,
// encrypted with the OS keystore (safeStorage), and NEVER in the webui's
// localStorage: that store belongs to the server's origin, is readable by any
// script that gets into the page, and survives nothing about a keystore.
//
// Electron-free on purpose, like host-probe.mjs: main.mjs passes the file path
// and `safeStorage` in, so the whole thing runs under plain vitest with a stub.
//
// The record is written in two halves. The server half is known at join time;
// the profile half only after the profile login the shell cannot see has
// succeeded (`remember:profile`). A record with only the first half is normal
// and means "not offerable yet".
import fs from "node:fs";
import path from "node:path";

/** Hard rule, same as electron/hosts.mjs: never plaintext. No keystore means
 * nothing is remembered — a fallback to a readable file would quietly turn
 * "remember me" into "leave both passwords on disk". */
export function writeRemembered(file, safeStorage, record) {
  if (!safeStorage?.isEncryptionAvailable?.()) return false;
  const enc = safeStorage.encryptString(JSON.stringify(record)).toString("base64");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Temp file + rename, so an interrupted write cannot leave a truncated blob
  // that decrypts to nothing.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ enc }), "utf8");
  fs.renameSync(tmp, file);
  return true;
}

/** The whole record, secrets included. Only the shell's own sign-in path calls
 * this; it is never handed to a renderer. */
export function readRemembered(file, safeStorage) {
  let enc;
  try {
    enc = JSON.parse(fs.readFileSync(file, "utf8"))?.enc;
  } catch {
    return null;
  }
  if (typeof enc !== "string" || !enc) return null;
  try {
    const record = JSON.parse(safeStorage.decryptString(Buffer.from(enc, "base64")));
    return record && typeof record === "object" ? record : null;
  } catch {
    // A blob this keystore cannot open (copied profile, re-created OS user) is
    // the same as no saved login. The file is left alone; the next write
    // replaces it.
    return null;
  }
}

/** What the sign-in screen is allowed to learn: enough to say "sign in as X on
 * Y", and not one password. `null` until the profile half landed — offering a
 * one-tap that cannot log in is worse than not offering one. */
export function rememberedEntry(file, safeStorage) {
  const record = readRemembered(file, safeStorage);
  if (!record?.url || !record.username || !record.password) return null;
  return { url: record.url, serverName: record.serverName ?? "", username: record.username };
}

export function forgetRemembered(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The profile half, written after a login succeeded. A no-op when no server
 * half is pending: that is "remember me" left unchecked, or a browser. */
export function rememberProfile(file, safeStorage, username, password) {
  const record = readRemembered(file, safeStorage);
  if (!record?.url || !username || !password) return false;
  return writeRemembered(file, safeStorage, { ...record, username, password });
}
