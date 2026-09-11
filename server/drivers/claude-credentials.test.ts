import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeAuthState, claudeCredentialPaths, claudeIsAuthenticated } from "./claude.ts";

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

// multibot: plik z `claudeAiOauth.expiresAt` 0 albo w przeszłości to NIE
// zalogowanie (telefon Kacpra 11.09.2026: plik był, expiresAt 0, każda tura
// padała na „Failed to authenticate"). Brak pola = stary format, liczy się.
describe("claudeAuthState — expiresAt", () => {
  const withCreds = (body: unknown) => {
    const configDir = mkdtempSync(join(tmpdir(), "mb-claude-exp-"));
    writeFileSync(join(configDir, ".credentials.json"), JSON.stringify(body));
    return { HOME: emptyHome(), CLAUDE_CONFIG_DIR: configDir, PREFIX: emptyHome() };
  };

  it("expiresAt 0 → expired", () => {
    const env = withCreds({ claudeAiOauth: { expiresAt: 0, subscriptionType: "max" } });
    expect(claudeAuthState(env)).toEqual({ authenticated: false, reason: "expired" });
    expect(claudeIsAuthenticated(env)).toBe(false);
  });

  it("expiresAt w przeszłości → expired", () => {
    const env = withCreds({ claudeAiOauth: { expiresAt: Date.now() - 60_000 } });
    expect(claudeAuthState(env)).toEqual({ authenticated: false, reason: "expired" });
  });

  it("expiresAt w przyszłości → zalogowany", () => {
    const env = withCreds({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000 } });
    expect(claudeAuthState(env)).toEqual({ authenticated: true });
  });

  it("brak pola → plik liczy się jak dotąd", () => {
    expect(claudeAuthState(withCreds({ claudeAiOauth: { accessToken: "x" } }))).toEqual({ authenticated: true });
    expect(claudeAuthState(withCreds({}))).toEqual({ authenticated: true });
  });

  it("brak pliku → missing; klucz w środowisku wygrywa z wygasłym plikiem", () => {
    expect(claudeAuthState({ HOME: emptyHome(), PREFIX: emptyHome() })).toEqual({ authenticated: false, reason: "missing" });
    const env = withCreds({ claudeAiOauth: { expiresAt: 0 } });
    expect(claudeAuthState({ ...env, ANTHROPIC_API_KEY: "k" })).toEqual({ authenticated: true });
  });
});
