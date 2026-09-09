import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STALE_CLI_RE,
  lastToolUpdate,
  resetCliUpdateForTests,
  scheduleHarnessUpdates,
  staleCliNotice,
  updateAll,
  updateCommand,
  updateTool,
} from "./cli-update.ts";

/** execFile stand-in: records the calls and answers with canned output. */
function fakeRun(reply: { error?: Error; stdout?: string; stderr?: string; onCall?: () => void } = {}) {
  const calls: Array<{ file: string; args: string[]; options: { timeout: number; windowsHide: boolean } }> = [];
  const run = (file: string, args: string[], options: any, cb: any) => {
    calls.push({ file, args, options });
    reply.onCall?.();
    cb(reply.error ?? null, reply.stdout ?? "", reply.stderr ?? "");
    return undefined;
  };
  return { calls, run, line: () => calls.map((c) => [c.file, ...c.args].join(" ")) };
}

/**
 * In-memory fs with regular files AND symlinks — the symlink half is the point:
 * writeFileSync here follows a link exactly like the real one, so a restore that
 * forgets to unlink first corrupts the target in this fake too.
 */
function fakeFs(path: string, content: string | null) {
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  if (content !== null) files.set(path, content);
  const target = (p: string) => links.get(p) ?? p;
  const state = {
    chmod: 0,
    get content() {
      return files.get(path) ?? null;
    },
    get isLink() {
      return links.has(path);
    },
    read: (p: string) => files.get(p) ?? null,
    /** what `npm install -g` leaves behind: a symlink into node_modules */
    symlink: (to: string, body: string) => {
      files.delete(path);
      files.set(to, body);
      links.set(path, to);
    },
  };
  const fs = {
    lstatSync: (p: string) => {
      if (links.has(p)) return { isFile: () => false, size: 1 };
      const body = files.get(p);
      if (body === undefined) throw new Error("ENOENT");
      return { isFile: () => true, size: body.length };
    },
    readFileSync: (p: string) => {
      const body = files.get(target(p));
      if (body === undefined) throw new Error("ENOENT");
      return body;
    },
    writeFileSync: (p: string, data: string) => {
      files.set(target(p), data);
    },
    chmodSync: (_p: string, mode: number) => {
      state.chmod = mode;
    },
    unlinkSync: (p: string) => {
      if (!links.delete(p) && !files.delete(p)) throw new Error("ENOENT");
    },
  };
  return { fs, state, which: () => path };
}

const TERMUX_SHIM = `#!/data/data/com.termux/files/usr/bin/sh
# MultiBot shim for the opencode CLI on Termux.
exec proot -b "$P/lib/musl/lib:/lib" "$P/lib/node_modules/opencode-linux-arm64-musl/bin/opencode" "$@"
`;

beforeEach(() => {
  resetCliUpdateForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.MULTIBOT_AUTO_UPDATE;
  resetCliUpdateForTests();
});

describe("updateCommand", () => {
  it("updates claude in place and every other CLI with the command the repo installs it with", () => {
    expect(updateCommand("claude")).toEqual({ command: "claude", args: ["update"] });
    expect(updateCommand("codex")).toEqual({ command: "npm", args: ["install", "-g", "@openai/codex@latest"] });
    expect(updateCommand("opencode")).toEqual({ command: "npm", args: ["install", "-g", "opencode-ai@latest"] });
    // no unattended install exists for these two, so nothing is guessed at
    expect(updateCommand("grok")).toBeNull();
    expect(updateCommand("kimi")).toBeNull();
    expect(updateCommand("not-a-tool")).toBeNull();
  });

  it("on Termux forces npm past the android platform check and names opencode's musl package", () => {
    process.env.TERMUX_VERSION = "0.118.0";
    try {
      expect(updateCommand("codex")).toEqual({
        command: "npm",
        args: ["install", "-g", "--force", "@openai/codex@latest"],
      });
      // opencode-ai has no android build at all; what is installed there is the
      // platform package scripts/install-opencode.mjs pulls, behind a proot shim
      expect(updateCommand("opencode")).toEqual({
        command: "npm",
        args: ["install", "-g", "--force", `opencode-linux-${process.arch === "arm64" ? "arm64" : "x64"}-musl@latest`],
      });
      // not an npm install, so nothing to force
      expect(updateCommand("claude")).toEqual({ command: "claude", args: ["update"] });
    } finally {
      delete process.env.TERMUX_VERSION;
    }
  });
});

describe("android platform dependency", () => {
  it("installs the optionalDependency npm skipped, under the alias the package declares", async () => {
    process.env.TERMUX_VERSION = "0.118.0";
    const root = "/data/data/com.termux/files/usr/lib/node_modules";
    const alias = `npm:@openai/codex@0.153.4-linux-${process.arch}`;
    const { fs, which } = fakeFs("/usr/bin/codex", null); // no shim here, only the dep step
    fs.writeFileSync(
      join(root, "@openai/codex", "package.json"),
      JSON.stringify({ optionalDependencies: { [`@openai/codex-linux-${process.arch}`]: alias } }),
    );
    const calls: string[] = [];
    const run = ((file: string, args: string[], _options: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
      const line = [file, ...args].join(" ");
      calls.push(line);
      cb(null, line.includes("install") ? "changed 1 package\n" : `${root}\n`, "");
    }) as never;
    try {
      const result = await updateTool("codex", { run, now: () => 1_000, fs, which });
      // the spawn is platform-resolved (Windows quotes every argument), so
      // assert on what the command line still contains
      expect(calls).toHaveLength(3);
      expect(calls[0]).toContain("@openai/codex@latest");
      expect(calls[0]).toContain("force");
      expect(calls[1]).toContain("root");
      expect(calls[2]).toContain(`@openai/codex-linux-${process.arch}@${alias}`);
      expect(result).toMatchObject({ ok: true });
    } finally {
      delete process.env.TERMUX_VERSION;
    }
  });
});

describe("updateTool", () => {
  it("runs the tool's command once and keeps the last non-empty line", async () => {
    const { calls, run } = fakeRun({ stdout: "Checking...\nUpdated to 2.1.263\n\n" });
    const result = await updateTool("claude", { run, now: () => 1_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["update"]);
    expect(calls[0].options).toMatchObject({ timeout: 5 * 60_000, windowsHide: true });
    expect(result).toMatchObject({ at: 1_000, ok: true, message: "Updated to 2.1.263" });
    expect(lastToolUpdate("claude")).toEqual(result);
    expect(lastToolUpdate("codex")).toBeNull();
  });

  it("debounces per tool: ten minutes for the same CLI, no wait for a different one", async () => {
    const { calls, run } = fakeRun({ stdout: "ok" });
    await updateTool("claude", { run, now: () => 1_000 });
    expect(await updateTool("claude", { run, now: () => 1_000 + 9 * 60_000 })).toBeNull();
    expect(calls).toHaveLength(1);
    await updateTool("codex", { run, now: () => 1_000, which: () => null });
    expect(calls).toHaveLength(2);
    await updateTool("claude", { run, now: () => 1_000 + 11 * 60_000 });
    expect(calls).toHaveLength(3);
  });

  it("never throws — a failing command and a throwing spawn both become recorded failures", async () => {
    const failing = await updateTool("claude", {
      run: fakeRun({ error: new Error("ENOENT"), stderr: "claude: not found" }).run,
      now: () => 1_000,
    });
    expect(failing).toMatchObject({ ok: false, message: "claude: not found" });

    const thrown = await updateTool("codex", {
      run: () => {
        throw new Error("spawn EACCES");
      },
      now: () => 1_000,
      which: () => null,
    });
    expect(thrown).toMatchObject({ ok: false });
    expect(thrown!.message).toContain("spawn EACCES");
  });
});

describe("Termux shim guard", () => {
  it("puts the MultiBot launcher back after npm replaced it", async () => {
    const { fs, state, which } = fakeFs("/usr/bin/opencode", TERMUX_SHIM);
    // what npm does: the shim file becomes npm's own launcher
    const { run } = fakeRun({ stdout: "+ opencode-ai@1.2.3", onCall: () => fs.writeFileSync("/usr/bin/opencode", "#!/usr/bin/env node\nrequire('opencode')\n") });
    await updateTool("opencode", { run, now: () => 1_000, fs, which });
    expect(state.content).toBe(TERMUX_SHIM);
    expect(state.chmod).toBe(0o755);
  });

  it("unlinks npm's symlink instead of writing the shim through it", async () => {
    // The live failure: writeFileSync followed the link, the shell script landed
    // in codex.js and every `codex --version` died with a SyntaxError on line 2.
    const entryPoint = "/usr/lib/node_modules/@openai/codex/bin/codex.js";
    const entryText = "#!/usr/bin/env node\nimport('../dist/main.js');\n";
    const { fs, state, which } = fakeFs("/usr/bin/codex", TERMUX_SHIM);
    const { run } = fakeRun({ stdout: "changed 1 package", onCall: () => state.symlink(entryPoint, entryText) });
    await updateTool("codex", { run, now: () => 1_000, fs, which });
    expect(state.isLink).toBe(false);
    expect(state.content).toBe(TERMUX_SHIM);
    expect(state.chmod).toBe(0o755);
    expect(state.read(entryPoint)).toBe(entryText);
  });

  it("leaves a launcher that is not ours alone, and survives a missing binary", async () => {
    const npmLauncher = "#!/usr/bin/env node\nrequire('codex')\n";
    const { fs, state, which } = fakeFs("/usr/bin/codex", npmLauncher);
    const { run } = fakeRun({ stdout: "+ @openai/codex@1", onCall: () => fs.writeFileSync("/usr/bin/codex", "replaced by npm") });
    await updateTool("codex", { run, now: () => 1_000, fs, which });
    expect(state.content).toBe("replaced by npm");

    resetCliUpdateForTests();
    const gone = fakeFs("/usr/bin/codex", null);
    const second = fakeRun({ stdout: "+ @openai/codex@1" });
    const result = await updateTool("codex", { run: second.run, now: () => 1_000, fs: gone.fs, which: gone.which });
    expect(result).toMatchObject({ ok: true });
  });
});

describe("updateAll", () => {
  it("walks the installed list and skips what has no update command", async () => {
    const { calls, run } = fakeRun({ stdout: "done" });
    const done = await updateAll(["claude", "grok", "codex"], { run, now: () => 1_000, which: () => null });
    expect(done).toHaveLength(2);
    // the spawn is platform-resolved (on Windows npm goes through cmd.exe with
    // its own quoting), so assert on what the command line still contains
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      expect.stringContaining("update"),
      expect.stringContaining("@openai/codex@latest"),
    ]);
  });
});

describe("staleCliNotice", () => {
  it("matches the API's stale-CLI error and leaves anything else alone", async () => {
    // Prime the debounce on the real clock first: the notice fires its own
    // updateTool("claude"), and nothing in this suite may spawn a real installer.
    const { calls, run } = fakeRun({ stdout: "ok" });
    await updateTool("claude", { run });

    const error =
      "API Error: 400 Claude Code 2.1.231 does not support this model; version 2.1.251 or newer is required. Run 'claude update'";
    expect(STALE_CLI_RE.test(error)).toBe(true);
    expect(STALE_CLI_RE.test("API Error: 401 authentication_error")).toBe(false);
    expect(staleCliNotice(error)).toContain("send the message again in a minute");
    expect(staleCliNotice("all good")).toBe("all good");
    expect(calls).toHaveLength(1);
  });
});

describe("scheduleHarnessUpdates", () => {
  it("arms a boot check and a daily one, and skips both on MULTIBOT_AUTO_UPDATE=0", () => {
    vi.useFakeTimers();
    scheduleHarnessUpdates(async () => []);
    expect(vi.getTimerCount()).toBe(2);

    vi.clearAllTimers();
    process.env.MULTIBOT_AUTO_UPDATE = "0";
    scheduleHarnessUpdates(async () => ["claude"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
