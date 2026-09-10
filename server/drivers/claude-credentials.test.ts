import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeCredentialPaths, claudeIsAuthenticated } from "./claude.ts";

// Na Termuxie `claude` to shim do proot-distro, więc `.credentials.json` nie leży
// w HOME harnessu tylko w rootfs kontenera. proot-distro zmieniło układ katalogów,
// a kod znał tylko starszy — na telefonie Kacpra (nowszy układ, plik JEST) claude
// meldował się jako niezalogowany.
const seedCreds = (...segments: string[]) => {
  const dir = join(...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), "{}");
  return join(dir, ".credentials.json");
};

const emptyHome = () => mkdtempSync(join(tmpdir(), "mb-claude-home-"));

describe("claudeCredentialPaths", () => {
  it("nowy układ proot-distro: containers/<distro>/rootfs/root", () => {
    const prefix = mkdtempSync(join(tmpdir(), "mb-claude-new-"));
    const wanted = seedCreds(prefix, "var", "lib", "proot-distro", "containers", "debian", "rootfs", "root", ".claude");
    const env = { HOME: emptyHome(), PREFIX: prefix };
    expect(claudeCredentialPaths(env)).toContain(wanted);
    expect(claudeIsAuthenticated(env)).toBe(true);
  });

  it("stary układ proot-distro nadal działa: installed-rootfs/<distro>/root", () => {
    const prefix = mkdtempSync(join(tmpdir(), "mb-claude-old-"));
    const wanted = seedCreds(prefix, "var", "lib", "proot-distro", "installed-rootfs", "ubuntu", "root", ".claude");
    const env = { HOME: emptyHome(), PREFIX: prefix };
    expect(claudeCredentialPaths(env)).toContain(wanted);
    expect(claudeIsAuthenticated(env)).toBe(true);
  });

  it("CLAUDE_CONFIG_DIR wygrywa z HOME", () => {
    const configDir = mkdtempSync(join(tmpdir(), "mb-claude-cfg-"));
    const wanted = seedCreds(configDir);
    const env = { HOME: emptyHome(), CLAUDE_CONFIG_DIR: configDir, PREFIX: emptyHome() };
    expect(claudeCredentialPaths(env)[0]).toBe(wanted);
    expect(claudeIsAuthenticated(env)).toBe(true);
  });

  it("klucz w środowisku to też zalogowanie — proxy nie ma żadnego pliku", () => {
    const env = { HOME: emptyHome(), PREFIX: emptyHome() };
    expect(claudeIsAuthenticated(env)).toBe(false);
    expect(claudeIsAuthenticated({ ...env, ANTHROPIC_API_KEY: "x" })).toBe(true);
    expect(claudeIsAuthenticated({ ...env, ANTHROPIC_AUTH_TOKEN: "x" })).toBe(true);
  });
});
