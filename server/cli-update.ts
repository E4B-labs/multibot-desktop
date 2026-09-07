// Keeping the installed agent CLIs current.
//
// A stale CLI is not a slow bot, it is a dead one: the API refuses the turn
// outright with "Claude Code 2.1.231 does not support this model; version
// 2.1.251 or newer is required. Run 'claude update'". Until this ran itself,
// somebody had to notice the chat had gone quiet and log into the device.
//
// `claude update` is the documented in-place fix for a native install (on
// Termux the $PREFIX/bin/claude shim forwards it into the proot distro). Every
// other CLI is refreshed with exactly the command this repo installs it with
// (server/cli-tools.ts), so package names live in one place.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { CLI_TOOLS } from "./cli-tools.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";

/** The API's "your CLI is too old" text, as it reaches the chat verbatim. */
export const STALE_CLI_RE = /version [\d.]+ or newer is required/i;

export interface CliUpdateResult {
  at: number;
  ok: boolean;
  message: string;
}

/** One run per tool per window: an update is a no-op once current, and a burst
 * of failing turns must not become a burst of installers. */
const DEBOUNCE_MS = 10 * 60_000;
const BOOT_DELAY_MS = 60_000;
const EVERY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 5 * 60_000;
/** A launcher we wrote is a few hundred bytes; a real CLI entry point is not. */
const SHIM_MAX_BYTES = 4096;

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

interface ShimFs {
  lstatSync: (path: string) => { isFile(): boolean; size: number };
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (path: string, data: string) => void;
  chmodSync: (path: string, mode: number) => void;
}

export interface UpdateDeps {
  run?: ExecFileLike;
  now?: () => number;
  fs?: ShimFs;
  which?: (cli: string) => string | null;
}

const lastRunAt = new Map<string, number>();
const lastResult = new Map<string, CliUpdateResult>();

/** What this tool's last update did, for /api/cli-tools. */
export const lastToolUpdate = (tool: string): CliUpdateResult | null => lastResult.get(tool) ?? null;

/** Test hook — the debounce is process-wide otherwise. */
export function resetCliUpdateForTests(): void {
  lastRunAt.clear();
  lastResult.clear();
}

/**
 * How a tool is kept current, or null when we have no unattended way to do it
 * (grok ships no install command, kimi only a native script that refuses to
 * touch an existing install).
 */
export function updateCommand(tool: string): { command: string; args: string[] } | null {
  // In-place and shim-safe: it replaces the binary the native installer put
  // there, which is exactly what the Termux launcher points at.
  if (tool === "claude") return { command: "claude", args: ["update"] };
  return CLI_TOOLS.find((item) => item.id === tool)?.install ?? null;
}

/** Where `cli` resolves on PATH. Windows has no proot and no shims, so the
 * lookup only exists for the shim guard below. */
function whichCli(cli: string): string | null {
  if (process.platform === "win32") return null;
  for (const dir of augmentedPath().split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cli);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * On Termux every musl CLI is launched through a shim this repo writes
 * (scripts/install-codex.mjs, scripts/install-opencode.mjs): proot bindings for
 * the musl loader, /etc/resolv.conf and the CA bundle Android has not got.
 * `npm install -g` replaces that file with its own launcher and the CLI loses
 * DNS outright — measured twice on the phone. So keep the shim's bytes before
 * npm runs and write them back afterwards, however npm ended.
 *
 * Returns the restore step, or null when there is no shim to protect.
 *
 * ponytail: a shim is recognised as a small `#!` script mentioning proot or
 * MultiBot — the two the installers write, and nothing npm or a package manager
 * owns (their launchers are symlinks, which lstat rejects here). An installer
 * that stops writing that marker loses the protection silently; the installers
 * and this check are a pair.
 */
function captureShim(tool: string, fs: ShimFs, which: (cli: string) => string | null): (() => void) | null {
  const path = which(tool);
  if (!path) return null;
  let text: string;
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.size > SHIM_MAX_BYTES) return null;
    text = fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!text.startsWith("#!") || !/MultiBot shim|proot/.test(text)) return null;
  return () => {
    try {
      if (fs.readFileSync(path, "utf8") === text) return;
      fs.writeFileSync(path, text);
      fs.chmodSync(path, 0o755);
      console.log(`[multibot] ${tool} update: restored the MultiBot launcher shim`);
    } catch (error) {
      console.warn(`[multibot] ${tool} update: shim restore failed:`, error);
    }
  };
}

const nodeFs = { lstatSync, readFileSync, writeFileSync, chmodSync };

/**
 * Update one CLI. Never throws and never rejects: an update that cannot happen
 * must not take a turn, a boot or a timer down with it. Returns null when the
 * tool has no update command or the debounce window swallowed the call.
 */
export async function updateTool(tool: string, deps: UpdateDeps = {}): Promise<CliUpdateResult | null> {
  const spec = updateCommand(tool);
  if (!spec) return null;
  const at = (deps.now ?? Date.now)();
  const previous = lastRunAt.get(tool);
  if (previous !== undefined && at - previous < DEBOUNCE_MS) return null;
  lastRunAt.set(tool, at);
  const run = deps.run ?? (execFile as ExecFileLike);
  let restoreShim: (() => void) | null = null;
  let result: CliUpdateResult;
  try {
    // Inside the try: resolving the binary walks PATH and reads shims, so it
    // can throw on its own (EACCES on a directory, an unreadable shim).
    const spawned = resolveCliSpawn(spec.command, spec.args);
    // Only a package manager rewrites the launcher; `claude update` does not.
    if (spec.command === "npm") {
      restoreShim = captureShim(tool, deps.fs ?? (nodeFs as ShimFs), deps.which ?? whichCli);
    }
    result = await new Promise<CliUpdateResult>((resolve) => {
      run(
        spawned.command,
        spawned.args,
        { timeout: TIMEOUT_MS, windowsHide: true, env: { ...process.env, PATH: augmentedPath() } },
        (error, stdout, stderr) => {
          const lines = `${stdout ?? ""}\n${stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
          resolve({ at, ok: !error, message: (lines.pop() ?? error?.message ?? "no output").slice(0, 200) });
        },
      );
    });
  } catch (error) {
    result = { at, ok: false, message: String(error).slice(0, 200) };
  }
  restoreShim?.();
  lastResult.set(tool, result);
  console.log(`[multibot] ${tool} update: ${result.message}`);
  return result;
}

/**
 * Update the given tools one at a time — two `npm install -g` runs at once
 * fight over the same global prefix. Tools with no update command are skipped.
 */
export async function updateAll(tools: readonly string[], deps: UpdateDeps = {}): Promise<CliUpdateResult[]> {
  const done: CliUpdateResult[] = [];
  for (const tool of tools) {
    const result = await updateTool(tool, deps);
    if (result) done.push(result);
  }
  return done;
}

/**
 * The chat sees the CLI's error text as-is. When it is the stale-version one,
 * start the update and say so — the same message retried in a minute works.
 */
export function staleCliNotice(text: string): string {
  if (!STALE_CLI_RE.test(text)) return text;
  void updateTool("claude");
  return `${text}\n\nMultiBot is updating Claude Code now, send the message again in a minute.`;
}

/** Boot + daily update of every installed harness, off under OMB_AUTO_UPDATE=0. */
export function scheduleHarnessUpdates(installedTools: () => Promise<readonly string[]>): void {
  if (process.env.OMB_AUTO_UPDATE === "0") return;
  const tick = async () => {
    try {
      await updateAll(await installedTools());
    } catch {
      /* detection is best-effort; the next tick tries again */
    }
  };
  // Never at import time: the boot must not wait on an installer, and the probe
  // that says which CLIs exist only finishes after `listen`.
  setTimeout(() => void tick(), BOOT_DELAY_MS).unref?.();
  setInterval(() => void tick(), EVERY_MS).unref?.();
}
