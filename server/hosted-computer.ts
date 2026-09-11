// multibot (H1/H2): the computer.
//
// ONE persistent Linux desktop per installation, shared by every bot. Not one
// per bot: a single machine is set up on the host and all agents act on that
// same desktop, so a login one bot performs is a login every bot already has.
// No modes, no source picker, no "off" — see PLAN-COMPUTER.md.
//
// Because it belongs to the installation rather than to any bot, deleting a bot
// never destroys it.
//
// Three facts learned from the H0 spike drive this file's shape:
//
//  1. The published host port CHANGES on every container restart. Docker picks
//     a fresh ephemeral port each time, so the port must be read back with
//     `docker port` on every use and never cached across a restart.
//  2. On Windows the daemon lives inside WSL, and the WSL VM suspends when no
//     session holds it open — every container gets SIGTERM. Only containers
//     with a restart policy come back when WSL wakes, so `--restart
//     unless-stopped` is mandatory, not a nicety.
//  3. Chrome >= 111 pins CDP to the container's own loopback and ignores
//     --remote-debugging-address, so the image bridges 9222 -> 9223 with socat
//     and we publish 9223. See Dockerfile.computer.
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runRaw = promisify(execFile);
// windowsHide: bez tego każde wywołanie docker/bash miga oknem konsoli na
// Windowsie (no-op na innych platformach).
const run = (file: string, args: string[], options: { timeout?: number; maxBuffer?: number } = {}) =>
  runRaw(file, args, { windowsHide: true, ...options });

/** Ports the image serves. cdp drives the browser over the DevTools protocol;
 *  novnc is the screen the user sees and takes over; api is cua's
 *  computer-server for whole-desktop input. */
export const CONTAINER_PORTS = { cdp: 9223, novnc: 6901, api: 8000 } as const;
export type PortName = keyof typeof CONTAINER_PORTS;

export const IMAGE = process.env.MULTIBOT_COMPUTER_IMAGE ?? "multibot-computer:dev";

/**
 * Two ways to run the same computer.
 *
 * `docker` is the default and the one with isolation. `native` runs the very
 * same pieces — X server, window manager, Chromium with CDP, websockify+noVNC —
 * directly on the host, for machines where Docker cannot exist at all. Termux
 * on an unrooted Android is the case that forced this: Docker needs kernel
 * privileges the phone will never grant.
 *
 * Chosen explicitly, never guessed: silently falling back to an unisolated
 * desktop because docker happened to be missing would hand an agent a shell on
 * the user's own machine without anyone deciding that.
 */
export type Backend = "docker" | "native";
export const BACKEND: Backend = process.env.MULTIBOT_COMPUTER_BACKEND === "native" ? "native" : "docker";

/** Native backend serves fixed ports — nothing allocates them dynamically. */
const NATIVE_PORTS: Record<PortName, number> = {
  cdp: Number(process.env.MULTIBOT_COMPUTER_CDP_PORT ?? 9223),
  novnc: Number(process.env.MULTIBOT_COMPUTER_NOVNC_PORT ?? 6901),
  api: 0, // cua's computer-server is container-only; nothing uses it today
};

const NATIVE_SCRIPT = process.env.MULTIBOT_COMPUTER_SCRIPT
  ?? join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "computer-native.sh");

/** Fixed names: there is exactly one, so nothing is derived from a bot id. */
export const CONTAINER_NAME = "multibot-computer";
export const VOLUME_NAME = "multibot-computer-data";

export interface ComputerLimits {
  /** container CPU quota, e.g. 2 == two cores */
  cpus: number;
  /** container memory cap, docker syntax, e.g. "3g" */
  memory: string;
}

export const DEFAULT_LIMITS: ComputerLimits = {
  cpus: Number(process.env.MULTIBOT_COMPUTER_CPUS ?? 2),
  memory: process.env.MULTIBOT_COMPUTER_MEMORY ?? "3g",
};

/**
 * How to invoke docker. On Windows there is no native daemon — it runs inside
 * the WSL distro — so every call is tunnelled through `wsl -d <distro>`.
 * Exported for tests; nothing else should need it.
 */
export function dockerCommand(argv: string[], platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") {
    const distro = process.env.MULTIBOT_WSL_DISTRO ?? "Ubuntu";
    return { file: "wsl", args: ["-d", distro, "-e", "docker", ...argv] };
  }
  return { file: "docker", args: argv };
}

/**
 * Hard off switch. The computer is a real container with a real volume, so a
 * test run — which boots the harness as a subprocess — must never provision it:
 * the first run of this file's integration left live containers behind and
 * exhausted the port range other tests bind to.
 *
 * `VITEST` is inherited by the spawned harness, so this holds for both the
 * in-process and the subprocess tests. `MULTIBOT_COMPUTER=off` is the manual
 * escape hatch for a host without docker — a phone in Termux, for instance.
 */
export function computersDisabled(): boolean {
  return Boolean(process.env.VITEST) || process.env.MULTIBOT_COMPUTER === "off";
}

async function docker(argv: string[], timeoutMs = 120_000): Promise<string> {
  if (computersDisabled()) throw new Error("the bot computer is disabled in this process");
  const { file, args } = dockerCommand(argv);
  const { stdout } = await run(file, args, { timeout: timeoutMs, maxBuffer: 8 << 20 });
  return stdout.trim();
}

async function dockerOk(argv: string[], timeoutMs = 120_000): Promise<boolean> {
  try {
    await docker(argv, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export type ComputerState = "provisioning" | "ready" | "recovering" | "error";

export interface ComputerStatus {
  state: ComputerState;
  /** host ports, freshly read — only present once the container is up */
  ports?: Record<PortName, number>;
  detail?: string;
}

/** `docker inspect` running-state, or null when the container does not exist. */
async function inspectRunning(): Promise<boolean | null> {
  try {
    return (await docker(["inspect", CONTAINER_NAME, "--format", "{{.State.Running}}"], 30_000)) === "true";
  } catch {
    return null;
  }
}

/**
 * Pull the host port out of `docker port` output, e.g. "127.0.0.1:32773".
 * Docker may print one line per protocol/family, and an IPv6 binding looks like
 * "[::1]:32773" — hence splitting on the LAST colon rather than the first.
 * Only loopback bindings are accepted: if a line ever came back bound to
 * 0.0.0.0 the computer would be exposed off-box, so we refuse it instead.
 */
export function parsePortOutput(out: string): number | null {
  for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const idx = line.lastIndexOf(":");
    if (idx < 0) continue;
    const host = line.slice(0, idx);
    if (!/^(127\.0\.0\.1|\[::1\]|localhost)$/.test(host)) continue;
    const port = Number(line.slice(idx + 1));
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return null;
}

/**
 * One port, read back from docker.
 *
 * The screen proxy resolves a port on EVERY request — each noVNC asset, each
 * websocket — and one `docker port` through WSL costs a second or two. A short
 * cache absorbs the burst of asset requests; it is deliberately brief because
 * the port changes whenever the container restarts, and a stale port must heal
 * on its own within seconds.
 */
const PORT_CACHE_MS = 5_000;
const portCache = new Map<PortName, { port: number; at: number }>();

export async function readPort(name: PortName): Promise<number | null> {
  if (BACKEND === "native") return NATIVE_PORTS[name] || null;
  const hit = portCache.get(name);
  if (hit && Date.now() - hit.at < PORT_CACHE_MS) return hit.port;
  let out: string;
  try {
    out = await docker(["port", CONTAINER_NAME, String(CONTAINER_PORTS[name])], 30_000);
  } catch {
    portCache.delete(name);
    return null;
  }
  const port = parsePortOutput(out);
  if (port === null) portCache.delete(name);
  else portCache.set(name, { port, at: Date.now() });
  return port;
}

/** Drop cached ports — after a restart they are certainly wrong. */
export function forgetPorts(): void {
  portCache.clear();
}

export async function readPorts(): Promise<Record<PortName, number> | null> {
  const ports = {} as Record<PortName, number>;
  for (const name of Object.keys(CONTAINER_PORTS) as PortName[]) {
    const port = await readPort(name);
    // `api` is the container image's cua server; the native backend has no
    // equivalent and nothing calls it, so its absence must not mean "down".
    if (port === null) {
      if (name === "api") continue;
      return null;
    }
    ports[name] = port;
  }
  return ports;
}

/** True once the browser inside the computer answers — the readiness signal
 *  that actually matters, since a running container is not a usable desktop. */
export async function probeReady(ports: Record<PortName, number>, timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${ports.cdp}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function createArgs(limits: ComputerLimits): string[] {
  return [
    "run", "-d",
    "--name", CONTAINER_NAME,
    // Mandatory: the WSL VM suspends and SIGTERMs everything; only a restart
    // policy brings the computer back when it wakes.
    "--restart", "unless-stopped",
    "-v", `${VOLUME_NAME}:/home/cua`,
    // Every port is bound to host loopback. Nothing about the computer is
    // reachable off-box; clients reach it only through the harness proxy.
    ...Object.values(CONTAINER_PORTS).flatMap((p) => ["-p", `127.0.0.1::${p}`]),
    // Ten sam ekran 16:9, co backend native — obraz ma w ENV 1024x768.
    "-e", `VNC_RESOLUTION=${process.env.MULTIBOT_COMPUTER_GEOMETRY ?? "1920x1080"}`,
    "--shm-size=1g",
    `--cpus=${limits.cpus}`,
    `--memory=${limits.memory}`,
    IMAGE,
  ];
}

const inFlight = { current: null as Promise<ComputerStatus> | null };

/** Losing a create race means the container exists — which is the goal. */
const isNameConflict = (e: unknown) => /already in use/i.test(e instanceof Error ? e.message : String(e));

/**
 * Bring the computer up and return its status. Idempotent: safe to call before
 * every turn and on every panel poll.
 *
 * Never falls back to "no computer" silently — a machine that cannot be
 * provisioned surfaces as `error` with a reason, because a quiet downgrade to
 * browser-only is exactly the failure mode PLAN-COMPUTER.md forbids.
 */
export function ensureComputer(limits = DEFAULT_LIMITS): Promise<ComputerStatus> {
  // The panel polls and turns fire independently — and now every bot shares one
  // container, so these races are more frequent, not fewer. The loser of a
  // create race used to surface "name already in use" as a user-visible error.
  return (inFlight.current ??= ensureOnce(limits).finally(() => {
    inFlight.current = null;
  }));
}

async function ensureNative(): Promise<ComputerStatus> {
  const ports = (await readPorts())!;
  // Already up? Then starting it again would be pointless work on a phone.
  if (await probeReady(ports)) return { state: "ready", ports };
  try {
    const { stderr } = await run("bash", [NATIVE_SCRIPT], { timeout: 120_000, maxBuffer: 8 << 20 });
    if (stderr?.trim()) console.warn("[multibot] native computer:", stderr.trim().slice(0, 200));
  } catch (e) {
    return { state: "error", detail: e instanceof Error ? e.message : String(e) };
  }
  return { state: (await probeReady(ports)) ? "ready" : "provisioning", ports };
}

/** Ports of the last computer that answered its CDP probe. A turn that finds the
 *  browser still answering on them skips the docker round trip entirely —
 *  on Windows every `docker …` is a `wsl` launch (measured 5.4 s for
 *  `inspect` alone, plus one `port` call per published port), and it ran at the
 *  start of EVERY turn, so each bot answer carried ~10 s of dead time. */
let lastReadyPorts: Record<PortName, number> | null = null;
/** Test hook: pretend a computer answered on these ports. */
export function rememberReadyPorts(ports: Record<PortName, number> | null): void {
  lastReadyPorts = ports;
}

async function ensureOnce(limits: ComputerLimits): Promise<ComputerStatus> {
  if (BACKEND === "native") return ensureNative();
  if (lastReadyPorts && (await probeReady(lastReadyPorts))) return { state: "ready", ports: lastReadyPorts };
  lastReadyPorts = null;
  try {
    const running = await inspectRunning();
    if (running === null) {
      await docker(["volume", "create", VOLUME_NAME], 60_000);
      try {
        await docker(createArgs(limits), 180_000);
      } catch (e) {
        // Another process (or an earlier boot) got there first. Treat it as
        // created and make sure it is up, rather than reporting a failure.
        if (!isNameConflict(e)) throw e;
        await docker(["start", CONTAINER_NAME], 120_000).catch(() => {});
      }
    } else if (!running) {
      await docker(["start", CONTAINER_NAME], 120_000);
    }
    forgetPorts();
  } catch (e) {
    return { state: "error", detail: e instanceof Error ? e.message : String(e) };
  }

  const ports = await readPorts();
  if (!ports) return { state: "provisioning", detail: "ports not published yet" };
  const ready = await probeReady(ports);
  if (ready) lastReadyPorts = ports;
  return { state: ready ? "ready" : "provisioning", ports };
}

/**
 * Bring back a computer that already exists, without ever creating one.
 *
 * Boot uses this rather than `ensureComputer`: creating a container as a side
 * effect of starting the harness turned every throwaway test run into a real
 * container. The computer is created when someone actually uses it — a turn, or
 * opening the panel.
 */
export async function resumeComputer(): Promise<boolean> {
  if (BACKEND === "native") {
    const ports = await readPorts();
    return Boolean(ports && (await probeReady(ports)));
  }
  const running = await inspectRunning();
  if (running === null) return false; // never created — not our job here
  if (running) return true;
  const started = await dockerOk(["start", CONTAINER_NAME], 120_000);
  forgetPorts();
  return started;
}

/** Run a command inside the computer. This is the shared terminal — the same
 *  filesystem the desktop and the browser see. */
export async function exec(command: string, timeoutMs = 60_000): Promise<string> {
  if (BACKEND === "native") {
    // No container to step into: this runs as the harness user, on this
    // machine. See the security note at the top of scripts/computer-native.sh.
    if (computersDisabled()) throw new Error("the bot computer is disabled in this process");
    const { stdout, stderr } = await run("bash", ["-lc", command], { timeout: timeoutMs, maxBuffer: 8 << 20 });
    return (stdout + (stderr ?? "")).trim();
  }
  return docker(["exec", CONTAINER_NAME, "bash", "-lc", command], timeoutMs);
}

/** How a command reaches the computer for `readComputerFile` — injectable so
 *  tests can fake the container without a docker daemon. */
export type ComputerCommandRunner = (argv: string[], timeoutMs: number, maxBuffer: number) => Promise<string>;

const defaultRunner: ComputerCommandRunner = async (argv, timeoutMs, maxBuffer) => {
  if (computersDisabled()) throw new Error("the bot computer is disabled in this process");
  const { file, args } = dockerCommand(argv);
  const { stdout } = await run(file, args, { timeout: timeoutMs, maxBuffer });
  return stdout;
};

/**
 * Read one file from INSIDE the computer container, size-capped.
 *
 * Fallback for bot→user file delivery: the agent writes its file with the
 * computer tools, so the path it hands to `send_file` lives in the container's
 * filesystem, not the host's — `resolveBotFile` cannot see it. Deliberately
 * container-only: on the `native` backend the computer IS the host, so the
 * direct host lookup already covered it, and re-running the read here would
 * just be a second way to read arbitrary host files.
 *
 * Base64 over `docker exec` stdout is fine (unlike the box REST run-command
 * channel, which corrupts binary output — see computer-proxy.ts).
 */
export async function readComputerFile(
  path: string,
  maxBytes: number,
  runner: ComputerCommandRunner = defaultRunner,
  backend: Backend = BACKEND,
): Promise<Buffer> {
  const raw = String(path ?? "").trim();
  // Newlines/NUL would break the quoted shell command; a real path has neither.
  if (!raw || /[\r\n\0]/.test(raw)) throw Object.assign(new Error("path required"), { status: 422 });
  if (backend !== "docker") {
    throw Object.assign(new Error(`no such file: ${raw} (not on the host; the computer fallback is container-only)`), { status: 404 });
  }
  const quoted = `'${raw.replace(/'/g, "'\\''")}'`;
  let sizeOut = "";
  try {
    sizeOut = await runner(["exec", CONTAINER_NAME, "bash", "-lc", `stat -c %s -- ${quoted}`], 30_000, 1 << 20);
  } catch {
    throw Object.assign(new Error(`no such file: ${raw} (not on the host and not on the bot computer)`), { status: 404 });
  }
  const size = Number(sizeOut.trim());
  if (!Number.isFinite(size) || size <= 0) {
    throw Object.assign(new Error(`no such file: ${raw} (not on the host and not on the bot computer)`), { status: 404 });
  }
  if (size > maxBytes) {
    throw Object.assign(new Error(`file exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`), { status: 413 });
  }
  // base64 inflates 4/3 — budget for that plus slack, never less than the cap.
  const stdout = await runner(
    ["exec", CONTAINER_NAME, "bash", "-lc", `base64 -w0 -- ${quoted}`],
    120_000,
    Math.ceil(maxBytes * 1.5) + (1 << 20),
  );
  const buf = Buffer.from(stdout.trim(), "base64");
  if (!buf.length) throw Object.assign(new Error(`no such file: ${raw} (unreadable on the bot computer)`), { status: 404 });
  return buf;
}

/**
 * Destroy the computer and everything on it — logins, files, browser profile.
 *
 * Nothing calls this automatically. It belongs to the installation, not to any
 * bot, so deleting a bot must NOT take it down: the remaining bots are still
 * using it, and its volume holds work that outlives any single bot.
 */
export async function removeComputer(): Promise<void> {
  await dockerOk(["rm", "-f", CONTAINER_NAME], 120_000);
  await dockerOk(["volume", "rm", VOLUME_NAME], 60_000);
  forgetPorts();
}

/** Docker reachable at all? Used to tell "no docker installed" apart from
 *  "the computer is broken", which are very different user problems. */
export async function dockerAvailable(): Promise<boolean> {
  // The native backend needs no daemon, so "is docker there" cannot fail it.
  if (BACKEND === "native") return true;
  return dockerOk(["version", "--format", "{{.Server.Version}}"], 30_000);
}
