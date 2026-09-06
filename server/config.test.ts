import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs, instanceConfigs, loadConfig, saveConfig, type AppConfig } from "./config.ts";

describe("instanceConfigs", () => {
  // A config.json written before the Hermes engine was removed still says
  // `driver: "slafy"`. Reading it must silently land on the chat-completions
  // driver, or every custom endpoint the user configured would go dark.
  it("overlays configured instances on the built-in fleet and migrates legacy slafy entries", () => {
    const cfg: AppConfig = {
      instances: {
        codex: { driver: "codex", enabled: false },
        opencodeGo: { driver: "slafy", environment: { OPENAI_API_KEY: "legacy-value" } },
        "local-qwen": {
          driver: "slafy",
          displayName: "Local Qwen",
          environment: { OPENAI_API_KEY: "local-key" },
          model: { default: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" },
        },
      },
    };

    const fleet = instanceConfigs(cfg);
    expect(Object.keys(fleet)).toEqual(
      expect.arrayContaining(["grok", "gemini", "kimi", "qwen", "claude", "codex", "opencode", "local-qwen"]),
    );
    expect(fleet.opencodeGo).toBeUndefined();
    expect(fleet.opencode.environment?.OPENCODE_API_KEY).toBe("legacy-value");
    // The engine instance and its driver are gone from the built-in fleet.
    expect(fleet.local).toBeUndefined();
    expect(fleet.slafy).toBeUndefined();
    expect(fleet.codex.enabled).toBe(false);
    expect(fleet["local-qwen"]).toMatchObject({
      driver: "openaiCompatible",
      displayName: "Local Qwen",
      environment: { OPENAI_API_KEY: "local-key" },
      config: { model: { default: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" } },
    });
    // Rendering the fleet must not mutate durable config objects.
    expect(cfg.instances?.["local-qwen"].driver).toBe("slafy");
    expect(cfg.instances?.["local-qwen"].config).toBeUndefined();
  });
});

// multibot: `saveConfig` scala WYŁĄCZNIE klucze z własnej białej listy, więc
// pole spoza niej ginie bez śladu — zapis wraca 200, a po restarcie nie ma
// niczego. Ten test pilnuje obu nowych ustawień właśnie przed tym.
describe("saveConfig: ustawienia aplikacji", () => {
  it("utrwala strefę czasową i autoweryfikację, nie ruszając reszty pliku", () => {
    ensureDirs();
    saveConfig({ box: { token: "keep-me" } });
    saveConfig({
      timeZone: "Europe/Warsaw",
      autoVerify: { enabled: true, rules: [{ id: "r1", when: "czytaj kalendarz", decision: "allow" }] },
    });

    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.timeZone).toBe("Europe/Warsaw");
    expect(disk.autoVerify).toEqual({
      enabled: true,
      rules: [{ id: "r1", when: "czytaj kalendarz", decision: "allow" }],
    });
    expect(disk.box.token).toBe("keep-me");
    expect(loadConfig().timeZone).toBe("Europe/Warsaw");
  });

  it("zapisuje pustą strefę, bo to znacząca wartość: wykryj automatycznie", () => {
    ensureDirs();
    saveConfig({ timeZone: "Asia/Tokyo" });
    saveConfig({ timeZone: "" });
    expect(loadConfig().timeZone).toBe("");
  });

  it("nowa lista reguł zastępuje starą, żeby dało się regułę usunąć", () => {
    ensureDirs();
    saveConfig({ autoVerify: { enabled: true, rules: [{ id: "a", when: "jeden", decision: "allow" }] } });
    saveConfig({ autoVerify: { enabled: false, rules: [] } });
    expect(loadConfig().autoVerify).toEqual({ enabled: false, rules: [] });
  });

  it("utrwala wspólny klucz OpenCode bez zmiany kształtu instancji", () => {
    ensureDirs();
    saveConfig({ opencode: { key: "configured-value" } });
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.opencode).toEqual({ key: "configured-value" });
    expect(instanceConfigs({ opencode: { key: "configured-value" } }).opencode.environment).toEqual({
      OPENCODE_API_KEY: "configured-value",
    });
  });
});

describe("config permissions", () => {
  it("hardens migrated data and rewritten secrets on POSIX", () => {
    if (process.platform === "win32") return;
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o777 });
    const path = join(DATA_DIR, "config.json");
    writeFileSync(path, "{}", { mode: 0o666 });
    chmodSync(DATA_DIR, 0o777);
    chmodSync(path, 0o666);

    ensureDirs();
    saveConfig({ box: { token: "test-token" } });

    expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
