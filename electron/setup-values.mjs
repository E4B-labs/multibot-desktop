// The three values a fresh server prints for its owner. The generated password
// is only ever stored as a hash, so `setup.json` beside `identity.db` is the one
// place it exists in the clear — and only until the first profile claims the
// server. A browser tab cannot read a file; Electron main can, which is the
// entire reason this bridge exists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Same resolution as server/config.ts, so the shell and the harness never
 * disagree about which directory is "the" data directory. */
export function setupFilePath(env = process.env, home = os.homedir()) {
  const explicit = typeof env.OMB_DATA_DIR === "string" ? env.OMB_DATA_DIR.trim() : "";
  return path.join(explicit || path.join(home, ".openmausbot"), "setup.json");
}

/** Pure. `null` for anything that is not a readable pending setup — a spent
 * server (file deleted), a truncated write, a directory that never had one. */
export function parseSetupFile(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { serverName, serverPassword, setupToken, address, tlsFingerprint } = parsed;
  if (typeof serverName !== "string" || !serverName) return null;
  if (typeof serverPassword !== "string" || !serverPassword) return null;
  if (typeof setupToken !== "string" || !setupToken) return null;
  // Od 0.4.0 (TLS) plik wiezie też adres i odcisk certyfikatu — komplet dla
  // kogoś, kto czyta plik zamiast patrzeć na konsolę. Oba są opcjonalne: to
  // odpowiedź serwera jest źródłem prawdy, plik tylko zapasem.
  return {
    serverName,
    serverPassword,
    setupToken,
    ...(typeof address === "string" && address ? { address } : {}),
    ...(typeof tlsFingerprint === "string" && tlsFingerprint ? { tlsFingerprint } : {}),
  };
}

/** What the renderer is allowed to see. The setup token is deliberately NOT in
 * it: it is the file's proof of readership, not a value to put on a screen, and
 * the renderer has nothing to do with it. The server's own answer wins where it
 * has one — it is the side that knows its address, its certificate and how it
 * found them. */
export function setupValuesFrom(file, route) {
  if (!file) return null;
  const pick = (key) => {
    const live = route && typeof route[key] === "string" && route[key] ? route[key] : undefined;
    const stored = typeof file[key] === "string" && file[key] ? file[key] : undefined;
    return live ?? stored;
  };
  return {
    serverName: pick("serverName") ?? file.serverName,
    serverPassword: pick("serverPassword") ?? file.serverPassword,
    address: pick("address") ?? "",
    ...(pick("tlsFingerprint") ? { tlsFingerprint: pick("tlsFingerprint") } : {}),
    ...(pick("addressKind") ? { addressKind: pick("addressKind") } : {}),
    ...(route && typeof route.addressVerified === "boolean" ? { addressVerified: route.addressVerified } : {}),
    // Bez tego ekran setupu nie umie powiedzieć „operator chowa to urządzenie
    // za CGNAT-em" — a to jedyna informacja, po której widać, że adresu nie da
    // się użyć z zewnątrz, choć wygląda poprawnie.
    ...(route && route.portMapping && typeof route.portMapping === "object" ? { portMapping: route.portMapping } : {}),
  };
}

export function readSetupFile(file = setupFilePath()) {
  try {
    return parseSetupFile(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The address, the certificate fingerprint and how the address was found are
 * the server's to report, and `/api/setup/values` already reports them — it just
 * wants the token out of the file as proof the caller could read it.
 *
 * `get` jest wstrzykiwany (`getJson` z host-probe.mjs), bo od 0.4.0 lokalny
 * harness stoi na HTTPS z certyfikatem z własnego podpisu, którego `fetch` w
 * main procesie nie przyjmie — a testy dzięki temu nie potrzebują gniazda. */
export async function fetchSetupRoute(get, baseUrl, setupToken) {
  const { status, json } = await get(`${baseUrl}/api/setup/values`, { headers: { "x-multibot-setup": setupToken } });
  return status === 200 ? json : null;
}

export async function collectSetupValues(get, baseUrl, file = setupFilePath()) {
  const pending = readSetupFile(file);
  if (!pending) return null;
  return setupValuesFrom(pending, await fetchSetupRoute(get, baseUrl, pending.setupToken));
}
