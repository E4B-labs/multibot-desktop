import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killTree } from "./kill-tree.ts";

// multibot: killTree's job is "make the process go away, tree included" —
// the smallest real check is a real child process that actually dies.
describe("killTree", () => {
  it("kills a spawned child process", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));

    killTree(child);

    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(exited).toBe(true);
  });

  it("is a no-op on an already-exited child", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise<void>((resolve) => child.once("exit", () => resolve())); // real exit sets exitCode
    expect(() => killTree(child)).not.toThrow();
  });
});
