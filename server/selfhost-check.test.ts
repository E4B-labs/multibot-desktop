import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/selfhost-check.mjs is the only thing that keeps the install paths
// honest (loopback publish, TLS on, the three values printed), and CI has never
// run it on its own. Running it here costs one process and makes every one of
// its assertions a real test.
const script = fileURLToPath(new URL("../scripts/selfhost-check.mjs", import.meta.url));

describe("self-host install paths", () => {
  it("passes the structural check without starting anything", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    // Status first: the checker reports its failure on stderr, and asserting the
    // output first would hide the message that says which install path broke.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK (no services started)");
  });
});
