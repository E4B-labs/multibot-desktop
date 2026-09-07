import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STALE_CLI_RE,
  lastClaudeUpdate,
  resetCliUpdateForTests,
  scheduleClaudeUpdates,
  staleCliNotice,
  updateClaude,
} from "./cli-update.ts";

/** execFile stand-in: records the calls and answers with canned output. */
function fakeRun(reply: { error?: Error; stdout?: string; stderr?: string } = {}) {
  const calls: Array<{ file: string; args: string[]; options: { timeout: number; windowsHide: boolean } }> = [];
  const run = (file: string, args: string[], options: any, cb: any) => {
    calls.push({ file, args, options });
    cb(reply.error ?? null, reply.stdout ?? "", reply.stderr ?? "");
    return undefined;
  };
  return { calls, run };
}

beforeEach(() => {
  resetCliUpdateForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.OMB_AUTO_UPDATE;
  resetCliUpdateForTests();
});

describe("updateClaude", () => {
  it("runs `claude update` once and keeps the last non-empty line", async () => {
    const { calls, run } = fakeRun({ stdout: "Checking...\nUpdated to 2.1.263\n\n" });
    const result = await updateClaude({ run, now: () => 1_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["update"]);
    expect(calls[0].options).toMatchObject({ timeout: 5 * 60_000, windowsHide: true });
    expect(result).toMatchObject({ at: 1_000, ok: true, message: "Updated to 2.1.263" });
    expect(lastClaudeUpdate()).toEqual(result);
  });

  it("debounces a second call inside ten minutes and lets a later one through", async () => {
    const { calls, run } = fakeRun({ stdout: "ok" });
    await updateClaude({ run, now: () => 1_000 });
    expect(await updateClaude({ run, now: () => 1_000 + 9 * 60_000 })).toBeNull();
    expect(calls).toHaveLength(1);
    await updateClaude({ run, now: () => 1_000 + 11 * 60_000 });
    expect(calls).toHaveLength(2);
  });

  it("never throws — a failing command becomes a recorded failure", async () => {
    const failing = await updateClaude({
      run: fakeRun({ error: new Error("ENOENT"), stderr: "claude: not found" }).run,
      now: () => 1_000,
    });
    expect(failing).toMatchObject({ ok: false, message: "claude: not found" });

    resetCliUpdateForTests();
    const thrown = await updateClaude({
      run: () => {
        throw new Error("spawn EACCES");
      },
      now: () => 2_000,
    });
    expect(thrown).toMatchObject({ ok: false });
    expect(thrown!.message).toContain("spawn EACCES");
  });
});

describe("staleCliNotice", () => {
  it("matches the API's stale-CLI error and leaves anything else alone", async () => {
    // Prime the debounce on the real clock first: the notice fires its own
    // updateClaude(), and nothing in this suite may spawn a real installer.
    const { calls, run } = fakeRun({ stdout: "ok" });
    await updateClaude({ run });

    const error =
      "API Error: 400 Claude Code 2.1.231 does not support this model; version 2.1.251 or newer is required. Run 'claude update'";
    expect(STALE_CLI_RE.test(error)).toBe(true);
    expect(STALE_CLI_RE.test("API Error: 401 authentication_error")).toBe(false);
    expect(staleCliNotice(error)).toContain("send the message again in a minute");
    expect(staleCliNotice("all good")).toBe("all good");
    expect(calls).toHaveLength(1);
  });
});

describe("scheduleClaudeUpdates", () => {
  it("arms a boot check and a daily one, and skips both on OMB_AUTO_UPDATE=0", () => {
    vi.useFakeTimers();
    scheduleClaudeUpdates(async () => false);
    expect(vi.getTimerCount()).toBe(2);

    vi.clearAllTimers();
    process.env.OMB_AUTO_UPDATE = "0";
    scheduleClaudeUpdates(async () => true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
