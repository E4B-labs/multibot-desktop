import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/selfhost-check.mjs is the only thing that keeps the install paths
// honest (loopback publish, TLS on, the three values printed), and CI has never
// run it on its own. Running it here costs one process and makes every one of
// its assertions a real test.
describe("self-host install paths", () => {
  it("passes the structural check without starting anything", () => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "selfhost-check.mjs")], { encoding: "utf8" });
    expect(result.stderr + result.stdout).toContain("OK (no services started)");
    expect(result.status).toBe(0);
  });
});
