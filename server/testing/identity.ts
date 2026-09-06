// There is no installation-wide bearer token any more, so a spawned harness
// has to be bootstrapped the way a real first run is: set the server up over
// loopback, register the first (owner) profile, keep its access token. A test
// that reuses a data dir finds the server already configured and just signs in.
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
 * should carry as `Authorization: Bearer …`. */
export async function bootstrapAccessToken(base: string, deviceName = "vitest"): Promise<string> {
  const info = await (await fetch(`${base}/api/public/server`)).json() as { configured?: boolean };
  // `x-multibot-client: native` makes the server return the session token as
  // well — that is what outlives the 15-minute access token.
  const native = { "x-multibot-client": "native" };
  let result: { status: number; body: any };
  if (info?.configured) {
    result = await postJson(base, "/api/auth/login", { username: TEST_USERNAME, password: TEST_PASSWORD, deviceName }, native);
    if (result.status !== 200) throw new Error(`sign-in failed (${result.status}): ${JSON.stringify(result.body)}`);
  } else {
    const setup = await postJson(base, "/api/setup/server", { name: "Test server" });
    if (setup.status !== 201 || !setup.body?.serverPassword) {
      throw new Error(`server setup failed (${setup.status}): ${JSON.stringify(setup.body)}`);
    }
    result = await postJson(base, "/api/auth/register", {
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
      displayName: "Test Owner",
      serverPassword: setup.body.serverPassword,
      deviceName,
    }, native);
    if (result.status !== 201) throw new Error(`owner registration failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  const { accessToken, sessionToken } = result.body ?? {};
  if (!accessToken || !sessionToken) throw new Error(`bootstrap returned no credentials: ${JSON.stringify(result.body)}`);
  minted.set(accessToken, { base, session: sessionToken });
  installExpiryRetry();
  return accessToken;
}
