// Keeping the agent CLIs current — today only Claude Code.
//
// A stale `claude` is not a slow CLI, it is a dead bot: the API refuses the
// turn outright with "Claude Code 2.1.231 does not support this model; version
// 2.1.251 or newer is required. Run 'claude update'". `claude update` is the
// documented in-place fix for every native install (on Termux the
// $PREFIX/bin/claude shim forwards it into the proot distro), so the server
// runs it itself instead of waiting for someone to notice the chat is broken.
//
// ponytail: only `claude`. codex and opencode on the phone are musl builds
// behind hand-written proot shims — an npm/native reinstall overwrites those
// shims and leaves the CLI unable to resolve DNS at all, so those two stay
// manual until they ship an Android build.
import { execFile } from "node:child_process";

import { augmentedPath, resolveCliSpawn } from "./env-path.ts";

/** The API's "your CLI is too old" text, as it reaches the chat verbatim. */
export const STALE_CLI_RE = /version [\d.]+ or newer is required/i;

export interface CliUpdateResult {
  at: number;
  ok: boolean;
  message: string;
}

/** One run per window is plenty: `claude update` is a no-op once current, and
 * a burst of failing turns must not become a burst of installers. */
const DEBOUNCE_MS = 10 * 60_000;
const BOOT_DELAY_MS = 60_000;
const EVERY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 5 * 60_000;

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

let lastRunAt = -Infinity;
let lastResult: CliUpdateResult | null = null;

/** What the last `claude update` did, for /api/cli-tools. */
export const lastClaudeUpdate = (): CliUpdateResult | null => lastResult;

/** Test hook — the debounce is process-wide otherwise. */
export function resetCliUpdateForTests(): void {
  lastRunAt = -Infinity;
  lastResult = null;
}

/**
 * Run `claude update`. Never throws and never rejects: an update that cannot
 * happen must not take a turn, a boot or a timer down with it. Returns null
 * when the debounce window swallowed the call.
 */
export async function updateClaude(
  deps: { run?: ExecFileLike; now?: () => number } = {},
): Promise<CliUpdateResult | null> {
  const at = (deps.now ?? Date.now)();
  if (at - lastRunAt < DEBOUNCE_MS) return null;
  lastRunAt = at;
  const run = deps.run ?? (execFile as ExecFileLike);
  let result: CliUpdateResult;
  try {
    // Inside the try: resolving the binary walks PATH and reads shims, so it
    // can throw on its own (EACCES on a directory, a shim we cannot read).
    const spawn = resolveCliSpawn("claude", ["update"]);
    result = await new Promise<CliUpdateResult>((resolve) => {
      run(
        spawn.command,
        spawn.args,
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
  lastResult = result;
  console.log(`[multibot] claude update: ${result.message}`);
  return result;
}

/**
 * The chat sees the CLI's error text as-is. When it is the stale-version one,
 * start the update and say so — the same message retried in a minute works.
 */
export function staleCliNotice(text: string): string {
  if (!STALE_CLI_RE.test(text)) return text;
  void updateClaude();
  return `${text}\n\nMultiBot is updating Claude Code now, send the message again in a minute.`;
}

/** Boot + daily update, skipped entirely by OMB_AUTO_UPDATE=0. */
export function scheduleClaudeUpdates(claudeInstalled: () => Promise<boolean>): void {
  if (process.env.OMB_AUTO_UPDATE === "0") return;
  const tick = async () => {
    try {
      if (await claudeInstalled()) await updateClaude();
    } catch {
      /* detection is best-effort; the next tick tries again */
    }
  };
  // Never at import time: the boot must not wait on an installer, and the
  // probe that says whether claude exists only finishes after `listen`.
  setTimeout(() => void tick(), BOOT_DELAY_MS).unref?.();
  setInterval(() => void tick(), EVERY_MS).unref?.();
}
