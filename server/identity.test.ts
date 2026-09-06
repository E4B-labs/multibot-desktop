import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { generateServerName, IdentityError, IdentityStore, identityCookie, isServerName } from "./identity.ts";

const dirs: string[] = [];
const ADDRESS = "http://192.168.1.42:8799";
const OWNER = { username: "kacper", password: "profile-password-123", displayName: "Kacper", deviceName: "test" };

function newStore(prefix: string): IdentityStore {
  const dir = mkdtempSync(join(tmpdir(), `multibot-${prefix}-`));
  dirs.push(dir);
  return new IdentityStore(join(dir, "identity.db"));
}

/** Configure a server the way a first boot does and hand back its credentials. */
async function configured(prefix: string): Promise<{ store: IdentityStore; name: string; password: string }> {
  const store = newStore(prefix);
  const setup = await store.ensureConfigured(ADDRESS);
  if (!setup) throw new Error("a fresh store must configure itself");
  return { store, name: setup.serverName, password: setup.serverPassword };
}

async function failure(run: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof IdentityError) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error("expected the call to fail");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server name", () => {
  it("generates a slug the name validator accepts", () => {
    for (let i = 0; i < 50; i += 1) {
      const name = generateServerName();
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      expect(isServerName(name)).toBe(true);
    }
  });

  it("rejects anything that is not a lowercase slug", () => {
    for (const bad of ["", "a", "-otter", "otter-", "Brave-Otter", "brave otter", "brave_otter", "b".repeat(33)]) {
      expect(isServerName(bad)).toBe(false);
    }
  });
});

describe("first boot", () => {
  it("names the server, mints a password and leaves it in setup.json exactly once", async () => {
    const { store, name, password } = await configured("boot");
    expect(isServerName(name)).toBe(true);
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(store.publicInfo().configured).toBe(true);
    expect(store.publicInfo().name).toBe(name);
    expect(store.setupValues()).toEqual({ serverName: name, serverPassword: password });

    // A restart must not rotate anybody's credentials.
    expect(await store.ensureConfigured(ADDRESS)).toBeNull();
    expect(store.setupValues()?.serverPassword).toBe(password);
    store.close();
  });

  it("keeps a name the owner already chose", async () => {
    const { store, password } = await configured("rename");
    const owner = await store.register({ ...OWNER, serverPassword: password });
    await store.updateServer(owner.actor, "home-lab");
    // Second boot on a configured server: ensureConfigured is a no-op.
    expect(await store.ensureConfigured(ADDRESS)).toBeNull();
    expect(store.publicInfo().name).toBe("home-lab");
    store.close();
  });
});

describe("join", () => {
  it("says which of the three values is wrong", async () => {
    const blank = newStore("unconfigured");
    expect(await failure(blank.join("anything", "anything"))).toEqual({ status: 404, message: "server_not_set_up" });
    blank.close();

    const { store, name, password } = await configured("join");
    expect(await failure(store.join("some-other-name", password))).toEqual({ status: 401, message: "wrong_server_name" });
    expect(await failure(store.join(name, "not-the-password"))).toEqual({ status: 401, message: "wrong_server_password" });

    const joined = await store.join(`  ${name.toUpperCase()}  `, password);
    expect(joined.joinGrant).toBeTruthy();
    expect(joined.hasUsers).toBe(false);
    expect(joined.expiresAt).toBeGreaterThan(Date.now());
    await store.register({ ...OWNER, joinGrant: joined.joinGrant });
    expect((await store.join(name, password)).hasUsers).toBe(true);
    store.close();
  });

  it("spends a grant once and lets it expire", async () => {
    const { store } = await configured("grant");
    const start = 1_000_000;
    const { grant, expiresAt } = store.issueJoinGrant(start);
    expect(expiresAt).toBe(start + 5 * 60 * 1000);
    expect(store.consumeJoinGrant(grant, start + 1_000)).toBe(true);
    expect(store.consumeJoinGrant(grant, start + 1_000)).toBe(false);

    const stale = store.issueJoinGrant(start).grant;
    expect(store.consumeJoinGrant(stale, start + 5 * 60 * 1000)).toBe(false);
    expect(store.consumeJoinGrant("never-issued", start)).toBe(false);
    store.close();
  });
});

describe("profiles", () => {
  it("makes the first profile the owner and every later one a member", async () => {
    const { store, name, password } = await configured("profiles");
    const owner = await store.register({ ...OWNER, serverPassword: password });
    expect(owner.actor.role).toBe("owner");
    // The password existed only to show the person setting the server up.
    expect(existsSync(store.setupFile)).toBe(false);
    expect(store.setupValues()).toBeNull();

    const grant = (await store.join(name, password)).joinGrant;
    const member = await store.register({ username: "ola", password: "member-password-123", joinGrant: grant });
    expect(member.actor.role).toBe("member");
    expect((await failure(store.register({ username: "ola", password: "member-password-123", serverPassword: password }))).message).toBe("profile_name_taken");
    store.close();
  });

  it("separates a missing profile from a wrong password, and needs a grant either way", async () => {
    const { store, name, password } = await configured("login");
    await store.register({ ...OWNER, serverPassword: password });
    const grant = async () => (await store.join(name, password)).joinGrant;

    expect(await failure(store.login({ username: "ghost", password: OWNER.password, joinGrant: await grant() }))).toEqual({ status: 404, message: "no_such_profile" });
    expect(await failure(store.login({ username: OWNER.username, password: "wrong-password-1", joinGrant: await grant() }))).toEqual({ status: 401, message: "wrong_profile_password" });
    expect((await failure(store.login({ username: OWNER.username, password: OWNER.password }))).message).toBe("join_grant_invalid");
    expect((await store.login({ username: OWNER.username, password: OWNER.password, joinGrant: await grant() })).actor.role).toBe("owner");
    store.close();
  });

  it("round-trips an e-mail on the profile", async () => {
    const { store, password } = await configured("email");
    const owner = await store.register({ ...OWNER, serverPassword: password, email: "kacper@example.test" });
    expect(owner.actor.email).toBe("kacper@example.test");
    expect(store.actorForSessionToken(owner.sessionToken)?.email).toBe("kacper@example.test");

    const updated = store.updateProfile(owner.actor, "Kacper G", "new@example.test");
    expect(updated.email).toBe("new@example.test");
    expect(store.actorForSessionToken(owner.sessionToken)?.email).toBe("new@example.test");
    expect(store.updateProfile(owner.actor, "Kacper G", null).email).toBeNull();
    expect(() => store.updateProfile(owner.actor, "Kacper G", "not-an-email")).toThrow();
    store.close();
  });

  it("lets the owner recover but sends a member to the owner", async () => {
    const { store, name, password } = await configured("recover");
    const owner = await store.register({ ...OWNER, serverPassword: password });
    const member = await store.register({
      username: "ola",
      password: "member-password-123",
      joinGrant: (await store.join(name, password)).joinGrant,
    });

    const refused = await failure(store.recover({
      username: "ola",
      recoveryCode: member.recoveryCode,
      newPassword: "member-password-456",
      joinGrant: (await store.join(name, password)).joinGrant,
    }));
    expect(refused.status).toBe(403);

    const recovered = await store.recover({
      username: OWNER.username,
      recoveryCode: owner.recoveryCode,
      newPassword: "owner-password-456",
      joinGrant: (await store.join(name, password)).joinGrant,
    });
    expect(recovered.recoveryCode).not.toBe(owner.recoveryCode);
    expect(store.actorForRequest({ headers: { authorization: `Bearer ${owner.accessToken}` } })).toBeNull();
    store.close();
  });
});

describe("server credentials", () => {
  it("rotating the password kills the old one", async () => {
    const { store, name, password } = await configured("rotate");
    const owner = await store.register({ ...OWNER, serverPassword: password });
    const next = await store.rotateServerPassword(owner.actor);
    expect(next).not.toBe(password);
    expect((await failure(store.join(name, password))).message).toBe("wrong_server_password");
    expect((await store.join(name, next)).joinGrant).toBeTruthy();

    const member = await store.register({
      username: "ola",
      password: "member-password-123",
      joinGrant: (await store.join(name, next)).joinGrant,
    });
    expect((await failure(store.rotateServerPassword(member.actor))).status).toBe(403);
    store.close();
  });
});

describe("sessions", () => {
  it("keeps a session from a year ago alive across the 0.4.0 migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multibot-immortal-"));
    dirs.push(dir);
    const file = join(dir, "identity.db");
    const store = new IdentityStore(file);
    const setup = await store.ensureConfigured(ADDRESS);
    const owner = await store.register({ ...OWNER, serverPassword: setup?.serverPassword });
    store.close();

    // Backdate the session to what a 0.3.x install holds today: last seen a
    // year ago, absolute deadline already in the past.
    const year = 365 * 24 * 60 * 60 * 1000;
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE sessions SET created_at = ?, last_seen_at = ?, absolute_expires_at = ?")
      .run(Date.now() - year, Date.now() - year, Date.now() - 1_000);
    raw.close();

    const reopened = new IdentityStore(file);
    reopened.init();
    const cookie = identityCookie(owner.sessionToken, false);
    expect(reopened.actorForRequest({ headers: { cookie } })?.userId).toBe(owner.actor.userId);
    reopened.close();
  });
});
