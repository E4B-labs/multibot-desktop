// There is no installation-wide bearer token any more, so a spawned harness is
// bootstrapped the way a real first run is: read the setup token out of the
// server's own setup.json, ask it for the three values, join with them, register
// the first (owner) profile, keep its access token.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TEST_USERNAME = "test-owner";
export const TEST_PASSWORD = "test-owner-password";

async function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-multibot-protocol": "2", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// An access token lives 15 minutes; a slow suite outlives it and would start
// 401-ing halfway through. The session behind it lives for months, so we keep
// it and re-mint on demand. Every token we ever handed out stays known (mapped
// to the harness that issued it, because one suite boots two), so a call site
// holding an older string is refreshed too — none of the 12 harness suites has
// to grow its own retry.
type Credential = { base: string; session: string };
const minted = new Map<string, Credential>();
let retryInstalled = false;

async function mintAccessToken(credential: Credential): Promise<string> {
  const res = await postJson(credential.base, "/api/auth/access-token", {}, { "x-multibot-session": credential.session });
  if (res.status !== 200 || !res.body?.accessToken) {
    throw new Error(`access-token refresh failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  minted.set(res.body.accessToken as string, credential);
  return res.body.accessToken as string;
}

/** One wrapper for the whole worker: a 401 on a request that carried a token
 * WE minted is an expiry, so re-mint and replay it once. A 401 the test is
 * actually asserting (anonymous, or a deliberately wrong bearer) never matches
 * and is returned untouched.
 * ponytail: HTTP only — a WebSocket opened with an expired subprotocol token
 * still fails; every suite opens its sockets early enough that it cannot. */
function installExpiryRetry(): void {
  if (retryInstalled) return;
  retryInstalled = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const response = await original(input, init);
    if (response.status !== 401) return response;
    const headers = new Headers(init?.headers ?? input?.headers);
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const credential = minted.get(bearer);
    if (!credential) return response;
    headers.set("authorization", `Bearer ${await mintAccessToken(credential)}`);
    return original(input, { ...init, headers });
  };
}

/** Returns the identity access token every authenticated call in the suite
 * should carry as `Authorization: Bearer …`. `home` is the throwaway HOME the
 * harness was spawned with — the server's own `setup.json` lives under it, and
 * that file is the only place its generated password exists in the clear. */
export async function bootstrapAccessToken(base: string, home: string, deviceName = "vitest"): Promise<string> {
  const dataDir = join(home, ".openmausbot");
  // A suite that reboots a harness against the same data dir finds the owner
  // already registered and `setup.json` deleted with the registration. Sessions
  // never expire now, so the one from the first boot is still the way back in.
  const sessionFile = join(dataDir, "vitest-owner-session");
  if (existsSync(sessionFile)) {
    installExpiryRetry();
    return mintAccessToken({ base, session: readFileSync(sessionFile, "utf8").trim() });
  }
  const setup = JSON.parse(readFileSync(join(dataDir, "setup.json"), "utf8")) as { setupToken: string };
  const values = await fetch(`${base}/api/setup/values`, { headers: { "x-multibot-setup": setup.setupToken } });
  if (!values.ok) throw new Error(`setup values unavailable (${values.status}): ${await values.text()}`);
  const { serverName, serverPassword } = await values.json() as { serverName: string; serverPassword: string };
  const joined = await postJson(base, "/api/auth/join", { serverName, serverPassword });
  if (joined.status !== 200 || !joined.body?.joinGrant) {
    throw new Error(`join failed (${joined.status}): ${JSON.stringify(joined.body)}`);
  }
  // `x-multibot-client: native` makes the server return the session token as
  // well — that is what outlives the 15-minute access token.
  const result = await postJson(base, "/api/auth/register", {
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
    displayName: "Test Owner",
    joinGrant: joined.body.joinGrant,
    deviceName,
  }, { "x-multibot-client": "native" });
  if (result.status !== 201) throw new Error(`owner registration failed (${result.status}): ${JSON.stringify(result.body)}`);
  const { accessToken, sessionToken } = result.body ?? {};
  if (!accessToken || !sessionToken) throw new Error(`bootstrap returned no credentials: ${JSON.stringify(result.body)}`);
  writeFileSync(sessionFile, sessionToken, { mode: 0o600 });
  minted.set(accessToken, { base, session: sessionToken });
  installExpiryRetry();
  return accessToken;
}
