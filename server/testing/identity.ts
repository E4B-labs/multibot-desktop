// There is no installation-wide bearer token any more, so a spawned harness
// has to be bootstrapped the way a real first run is: set the server up over
// loopback, register the first (owner) profile, keep its access token. A test
// that reuses a data dir finds the server already configured and just signs in.
export const TEST_USERNAME = "test-owner";
export const TEST_PASSWORD = "test-owner-password";

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-multibot-protocol": "2" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Returns the identity access token every authenticated call in the suite
 * should carry as `Authorization: Bearer …`. */
export async function bootstrapAccessToken(base: string, deviceName = "vitest"): Promise<string> {
  const info = await (await fetch(`${base}/api/public/server`)).json() as { configured?: boolean };
  if (info?.configured) {
    const login = await postJson(base, "/api/auth/login", { username: TEST_USERNAME, password: TEST_PASSWORD, deviceName });
    if (login.status !== 200 || !login.body?.accessToken) {
      throw new Error(`sign-in failed (${login.status}): ${JSON.stringify(login.body)}`);
    }
    return login.body.accessToken as string;
  }
  const setup = await postJson(base, "/api/setup/server", { name: "Test server" });
  if (setup.status !== 201 || !setup.body?.serverPassword) {
    throw new Error(`server setup failed (${setup.status}): ${JSON.stringify(setup.body)}`);
  }
  const registered = await postJson(base, "/api/auth/register", {
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
    displayName: "Test Owner",
    serverPassword: setup.body.serverPassword,
    deviceName,
  });
  if (registered.status !== 201 || !registered.body?.accessToken) {
    throw new Error(`owner registration failed (${registered.status}): ${JSON.stringify(registered.body)}`);
  }
  return registered.body.accessToken as string;
}
