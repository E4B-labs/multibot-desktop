// MultiBot protocol v2 identity store.
// Secrets are never persisted in plaintext: SQLite stores password/recovery
// hashes, session hashes and short-lived access-token hashes only.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createHash, generateKeyPairSync, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";

const scryptAsync = (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password, salt, keylen, options, (error, derivedKey) => error ? reject(error) : resolve(derivedKey)));
const PASSWORD_N = 32_768;
const PASSWORD_R = 8;
const PASSWORD_P = 3;
const PASSWORD_KEY_BYTES = 32;
const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 365 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_MS = 15 * 60 * 1000;
export const IDENTITY_PROTOCOL = 2;
export const IDENTITY_SESSION_COOKIE = "mb_v2_session";

export type IdentityRole = "owner" | "member";
export interface IdentityActor {
  userId: string;
  username: string;
  displayName: string;
  role: IdentityRole;
}
export interface ServerPublicInfo {
  configured: boolean;
  serverId: string;
  name: string;
  protocol: number;
  generation: number;
  publicKey: string;
}
export interface CreatedServerSetup {
  server: ServerPublicInfo;
  serverPassword: string;
}
export interface CreatedSession {
  sessionToken: string;
  accessToken: string;
  actor: IdentityActor;
  expiresAt: number;
}
export interface CreatedRegistration extends CreatedSession {
  recoveryCode: string;
}

type Row = Record<string, string | number | Uint8Array | null>;

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

export function normalizeUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new IdentityError("invalid username", 422);
  return username;
}

function validatePassword(value: unknown, label = "password"): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new IdentityError(`${label} must contain 12-128 characters`, 422);
  }
  return value;
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, PASSWORD_KEY_BYTES, {
    N: PASSWORD_N,
    r: PASSWORD_R,
    p: PASSWORD_P,
    maxmem: 128 * 1024 * 1024,
  }) as Buffer;
  return `scrypt$${PASSWORD_N}$${PASSWORD_R}$${PASSWORD_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [kind, n, r, p, saltText, keyText] = encoded.split("$");
  if (kind !== "scrypt" || !n || !r || !p || !saltText || !keyText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(keyText, "base64url");
    const actual = await scryptAsync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * 1024 * 1024,
    }) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export class IdentityError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class IdentityStore {
  private readonly db: DatabaseSync;
  readonly file: string;
  private initialized = false;
  private setupInFlight = false;

  constructor(file = join(DATA_DIR, "identity.db")) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    if (process.platform !== "win32" && existsSync(file)) chmodSync(file, 0o600);
  }

  init(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        recovery_hash BLOB NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        created_at INTEGER NOT NULL,
        disabled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash BLOB PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS access_tokens (
        id_hash BLOB PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        user_id TEXT,
        action TEXT NOT NULL,
        target TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS access_user_idx ON access_tokens(user_id);
    `);
    this.ensureServerIdentity();
    this.initialized = true;
  }

  close(): void {
    this.db.close();
  }

  private ensureServerIdentity(): void {
    if (this.meta("server.publicKey")) return;
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "der" });
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "der" });
    const serverId = `mbs_${createHash("sha256").update(publicKey).digest("hex").slice(0, 32)}`;
    this.setMeta("server.publicKey", base64(publicKey));
    this.setMeta("server.privateKey", base64(privateKey));
    this.setMeta("server.id", serverId);
    this.setMeta("server.name", "MultiBot server");
    this.setMeta("server.generation", "1");
    this.setMeta("server.protocol", String(IDENTITY_PROTOCOL));
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  publicInfo(): ServerPublicInfo {
    this.init();
    return {
      configured: Boolean(this.meta("server.joinPasswordHash")),
      serverId: this.meta("server.id") ?? "",
      name: this.meta("server.name") ?? "MultiBot server",
      protocol: Number(this.meta("server.protocol") ?? IDENTITY_PROTOCOL),
      generation: Number(this.meta("server.generation") ?? 1),
      publicKey: this.meta("server.publicKey") ?? "",
    };
  }

  async configureServer(name?: unknown, serverPassword?: unknown): Promise<CreatedServerSetup> {
    this.init();
    if (this.meta("server.joinPasswordHash") || this.setupInFlight) throw new IdentityError("server already configured", 409);
    if (name !== undefined && name !== null && !validText(name, 80)) throw new IdentityError("server name required", 422);
    const resolvedName = name === undefined || name === null ? "MultiBot server" : name.trim();
    const password = serverPassword === undefined || serverPassword === null || serverPassword === ""
      ? `mb-${base64(randomBytes(18))}`
      : validatePassword(serverPassword, "server password");
    this.setupInFlight = true;
    try {
      this.setMeta("server.name", resolvedName);
      this.setMeta("server.joinPasswordHash", await passwordHash(password));
    } finally {
      this.setupInFlight = false;
    }
    this.audit(null, "server.created", this.publicInfo().serverId);
    return { server: this.publicInfo(), serverPassword: password };
  }

  private async joinPasswordMatches(password: unknown): Promise<boolean> {
    if (typeof password !== "string") return false;
    const stored = this.meta("server.joinPasswordHash");
    return Boolean(stored && await passwordMatches(password, stored));
  }

  async verifyJoinPassword(password: unknown): Promise<boolean> {
    this.init();
    return this.joinPasswordMatches(password);
  }

  async register(input: { username: unknown; password: unknown; displayName?: unknown; serverPassword: unknown; deviceName?: unknown }): Promise<CreatedRegistration> {
    this.init();
    if (!this.meta("server.joinPasswordHash")) throw new IdentityError("server setup required", 409);
    if (!await this.joinPasswordMatches(input.serverPassword)) throw new IdentityError("invalid server credentials", 401);
    const username = normalizeUsername(input.username);
    const password = validatePassword(input.password);
    const displayName = validText(input.displayName, 80) ? input.displayName.trim() : username;
    const existing = this.db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (existing) throw new IdentityError("username unavailable", 409);
    const userId = `usr_${randomBytes(16).toString("hex")}`;
    const role: IdentityRole = this.userCount() === 0 ? "owner" : "member";
    const recoveryCode = randomBytes(24).toString("base64url");
    this.db.prepare("INSERT INTO users(id, username, display_name, password_hash, recovery_hash, role, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)").run(
      userId, username, displayName, await passwordHash(password), hash(recoveryCode), role, Date.now(),
    );
    const session = this.createSession(userId, String(input.deviceName ?? "device"));
    this.audit(userId, "user.registered", userId);
    return { ...session, recoveryCode };
  }

  async login(usernameInput: unknown, passwordInput: unknown, deviceName: unknown): Promise<CreatedSession> {
    this.init();
    const username = normalizeUsername(usernameInput);
    const password = validatePassword(passwordInput);
    const row = this.db.prepare("SELECT * FROM users WHERE username = ? AND disabled_at IS NULL").get(username) as Row | undefined;
    if (!row || typeof row.password_hash !== "string" || !await passwordMatches(password, row.password_hash)) {
      throw new IdentityError("invalid credentials", 401);
    }
    const session = this.createSession(String(row.id), String(deviceName ?? "device"));
    this.audit(String(row.id), "user.login", String(row.id));
    return session;
  }

  issueAccessToken(actor: IdentityActor): { accessToken: string; expiresAt: number } {
    this.init();
    const now = Date.now();
    const accessToken = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO access_tokens(id_hash, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)").run(hash(accessToken), actor.userId, now, now + ACCESS_TOKEN_MS);
    return { accessToken, expiresAt: now + ACCESS_TOKEN_MS };
  }

  createSessionForActor(actor: IdentityActor, deviceName: unknown): CreatedSession {
    this.init();
    return this.createSession(actor.userId, String(deviceName ?? "device"));
  }

  async recover(usernameInput: unknown, recoveryInput: unknown, newPasswordInput: unknown, deviceName: unknown): Promise<CreatedRegistration> {
    this.init();
    const username = normalizeUsername(usernameInput);
    const recovery = typeof recoveryInput === "string" ? recoveryInput.trim() : "";
    const newPassword = validatePassword(newPasswordInput, "new password");
    const row = this.db.prepare("SELECT * FROM users WHERE username = ? AND disabled_at IS NULL").get(username) as Row | undefined;
    const storedRecovery = row?.recovery_hash instanceof Uint8Array ? Buffer.from(row.recovery_hash) : null;
    if (!row || !storedRecovery || storedRecovery.length !== 32 || !recovery || !timingSafeEqual(hash(recovery), storedRecovery)) {
      throw new IdentityError("invalid recovery credentials", 401);
    }
    const nextRecovery = randomBytes(24).toString("base64url");
    this.db.prepare("UPDATE users SET password_hash = ?, recovery_hash = ? WHERE id = ?").run(await passwordHash(newPassword), hash(nextRecovery), row.id);
    this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), row.id);
    this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), row.id);
    const session = this.createSession(String(row.id), String(deviceName ?? "recovery"));
    this.audit(String(row.id), "user.recovered", String(row.id));
    return { ...session, recoveryCode: nextRecovery };
  }

  private userCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as Row | undefined;
    return Number(row?.count ?? 0);
  }

  private actor(userId: string): IdentityActor | null {
    const row = this.db.prepare("SELECT id, username, display_name, role FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as Row | undefined;
    if (!row || typeof row.id !== "string" || typeof row.username !== "string" || typeof row.display_name !== "string") return null;
    return { userId: row.id, username: row.username, displayName: row.display_name, role: row.role === "owner" ? "owner" : "member" };
  }

  private createSession(userId: string, deviceName: string): CreatedSession {
    const now = Date.now();
    const sessionToken = randomBytes(32).toString("base64url");
    const accessToken = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO sessions(id_hash, user_id, device_name, created_at, last_seen_at, absolute_expires_at) VALUES(?, ?, ?, ?, ?, ?)").run(hash(sessionToken), userId, deviceName.slice(0, 120), now, now, now + SESSION_ABSOLUTE_MS);
    this.db.prepare("INSERT INTO access_tokens(id_hash, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)").run(hash(accessToken), userId, now, now + ACCESS_TOKEN_MS);
    const actor = this.actor(userId);
    if (!actor) throw new IdentityError("account unavailable", 401);
    return { sessionToken, accessToken, actor, expiresAt: now + ACCESS_TOKEN_MS };
  }

  actorForRequest(req: { headers: Record<string, string | string[] | undefined>; url?: string }): IdentityActor | null {
    this.init();
    const cookie = cookieValue(req.headers.cookie, IDENTITY_SESSION_COOKIE);
    if (cookie) return this.actorForSessionToken(cookie);
    let token = identityBearer(req);
    if (!token && req.url) {
      try {
        const url = new URL(req.url, "http://localhost");
        // ponytail: query token for VNC only; short-lived screen ticket if it
        // ever lands in proxy logs. A remote browser cannot set a header on the
        // websockify upgrade noVNC opens for itself, so the query is the only
        // credential that reaches it.
        if (url.pathname.includes("/computer/vnc/") || url.pathname.endsWith("/websockify")) token = url.searchParams.get("token");
      } catch {
        /* malformed URL cannot authenticate */
      }
    }
    if (!token) return null;
    const row = this.db.prepare("SELECT user_id, expires_at, revoked_at FROM access_tokens WHERE id_hash = ?").get(hash(token)) as Row | undefined;
    const now = Date.now();
    if (!row || row.revoked_at || now >= Number(row.expires_at)) return null;
    this.db.prepare("UPDATE access_tokens SET last_used_at = ? WHERE id_hash = ?").run(now, hash(token));
    return this.actor(String(row.user_id));
  }

  actorForSessionToken(value: unknown): IdentityActor | null {
    this.init();
    const token = typeof value === "string" ? value.trim() : "";
    if (!token) return null;
    const row = this.db.prepare("SELECT user_id, last_seen_at, absolute_expires_at, revoked_at FROM sessions WHERE id_hash = ?").get(hash(token)) as Row | undefined;
    const now = Date.now();
    if (!row || row.revoked_at || now - Number(row.last_seen_at) > SESSION_IDLE_MS || now >= Number(row.absolute_expires_at)) return null;
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now, hash(token));
    return this.actor(String(row.user_id));
  }

  logout(req: { headers: Record<string, string | string[] | undefined> }, all = false): void {
    const actor = all ? this.actorForRequest(req) : null;
    const cookie = cookieValue(req.headers.cookie, IDENTITY_SESSION_COOKIE);
    if (cookie) this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ?").run(Date.now(), hash(cookie));
    const token = identityBearer(req);
    if (token) this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE id_hash = ?").run(Date.now(), hash(token));
    if (all) {
      if (actor) {
        this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), actor.userId);
        this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), actor.userId);
      }
    }
  }

  listSessions(actor: IdentityActor): Array<{ id: string; deviceName: string; createdAt: number; lastSeenAt: number; current: boolean }> {
    const rows = this.db.prepare("SELECT id_hash, device_name, created_at, last_seen_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC").all(actor.userId) as Row[];
    return rows.map((row) => ({ id: base64(Buffer.from(row.id_hash as Uint8Array)), deviceName: String(row.device_name), createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at), current: false }));
  }

  revokeSession(actor: IdentityActor, id: string): boolean {
    const result = this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id_hash = ? AND revoked_at IS NULL").run(Date.now(), actor.userId, Buffer.from(id, "base64url"));
    return Number(result.changes) > 0;
  }

  updateProfile(actor: IdentityActor, displayName: unknown): IdentityActor {
    if (!validText(displayName, 80)) throw new IdentityError("display name required", 422);
    const value = displayName.trim();
    this.db.prepare("UPDATE users SET display_name = ? WHERE id = ? AND disabled_at IS NULL").run(value, actor.userId);
    return { ...actor, displayName: value };
  }

  async updateServer(actor: IdentityActor, name: unknown, serverPassword?: unknown): Promise<ServerPublicInfo> {
    if (actor.role !== "owner") throw new IdentityError("owner access required", 403);
    if (name !== undefined) {
      if (!validText(name, 80)) throw new IdentityError("server name required", 422);
      this.setMeta("server.name", name.trim());
    }
    if (serverPassword !== undefined) this.setMeta("server.joinPasswordHash", await passwordHash(validatePassword(serverPassword, "server password")));
    this.setMeta("server.generation", String(Number(this.meta("server.generation") ?? 1) + 1));
    this.audit(actor.userId, "server.updated", this.publicInfo().serverId);
    return this.publicInfo();
  }

  members(): Array<{ userId: string; username: string; displayName: string; role: IdentityRole; createdAt: number }> {
    const rows = this.db.prepare("SELECT id, username, display_name, role, created_at FROM users WHERE disabled_at IS NULL ORDER BY created_at").all() as Row[];
    return rows.filter((row) => typeof row.id === "string").map((row) => ({ userId: String(row.id), username: String(row.username), displayName: String(row.display_name), role: row.role === "owner" ? "owner" : "member", createdAt: Number(row.created_at) }));
  }

  private audit(userId: string | null, action: string, target?: string): void {
    this.db.prepare("INSERT INTO audit(at, user_id, action, target) VALUES(?, ?, ?, ?)").run(Date.now(), userId, action, target ?? null);
  }
}

function cookieValue(header: string | string[] | undefined, name: string): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      if (!value) return null;
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function identityCookie(value: string, secure: boolean, clear = false): string {
  return `${IDENTITY_SESSION_COOKIE}=${clear ? "" : encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 31_536_000}${secure ? "; Secure" : ""}`;
}

export function identityBearer(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
  const marker = protocols.indexOf("multibot-v2");
  return marker >= 0 && protocols[marker + 1] ? protocols[marker + 1] : null;
}

export function isIdentityPublicRoute(method: string, path: string): boolean {
  return (method === "GET" && (path === "/api/public/handshake" || path === "/api/public/server" || path === "/api/health")) ||
    (method === "POST" && ["/api/setup/server", "/api/auth/join", "/api/auth/register", "/api/auth/login", "/api/auth/recover"].includes(path));
}

/** A reverse proxy or a tunnel makes every request look like it came from
 * 127.0.0.1. A forwarding header is proof the peer is NOT local, so one guard
 * here closes the hole for every caller at once. */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip"] as const;

export function isLoopbackRequest(req: { socket: { remoteAddress?: string | undefined }; headers: Record<string, string | string[] | undefined> }): boolean {
  if (FORWARDING_HEADERS.some((header) => req.headers[header])) return false;
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** A self-hosted install often runs on plain-http loopback (no TLS terminator
 * in front). Unconditionally setting `Secure` would make the browser silently
 * drop the session cookie there, so it is added only over real TLS. */
export function isSecureRequest(req: { socket: unknown; headers: Record<string, string | string[] | undefined> }): boolean {
  if ((req.socket as { encrypted?: boolean } | null)?.encrypted) return true;
  return String(req.headers["x-forwarded-proto"] ?? "").toLowerCase() === "https";
}
