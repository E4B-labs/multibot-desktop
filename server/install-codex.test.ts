import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Codex native installer", () => {
  it("uses official standalone installer and verifies codex --version", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-codex.mjs");
    const result = spawnSync(process.execPath, [script, "--dry-run"], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(process.platform === "win32" ? "https://chatgpt.com/codex/install.ps1" : "https://chatgpt.com/codex/install.sh");
    expect(result.stdout).toContain("verify: codex --version");
  });
});
