import { describe, expect, it } from "vitest";

import { instanceGate } from "./instanceGate";

describe("instanceGate", () => {
  it("brak CLI to zawsze 'missing', nawet gdy snapshot niesie authenticated", () => {
    expect(instanceGate({ state: "unavailable" }, "geminiAgent")).toBe("missing");
    expect(instanceGate({ state: "unavailable", authenticated: true }, "grokAgent")).toBe("missing");
  });

  it("CLI jest, ale nikt się nim nie zalogował → 'signin'", () => {
    // Gemini 0.59 i Qwen 0.23 na telefonie Kacpra: zainstalowane i autoaktualizowane,
    // bez oauth_creds.json i bez klucza w env.
    expect(instanceGate({ state: "available", authenticated: false }, "geminiAgent")).toBe("signin");
    expect(instanceGate({ state: "available", authenticated: false }, "qwenAgent")).toBe("signin");
    expect(instanceGate({ state: "available", authenticated: false }, "kimiAgent")).toBe("signin");
    expect(instanceGate({ state: "available", authenticated: false }, "grokAgent")).toBe("signin");
  });

  it("OpenCode zostaje otwarty bez klucza — Zen free chodzi anonimowo", () => {
    expect(instanceGate({ state: "available", authenticated: false }, "opencode")).toBe("ok");
  });

  it("wyjątek idzie po driverKind, więc druga instancja OpenCode też go ma", () => {
    // `config.json` może postawić `instances: { "opencode-zapas": { driver: "opencode" } }`
    // — id jest inne, natura ta sama, więc bramka logowania nadal nie może zgasić Zen.
    expect(instanceGate({ state: "available", authenticated: false }, "opencode")).toBe("ok");
    // a driver o innym rodzaju nie łapie się na wyjątek przez samo podobne id
    expect(instanceGate({ state: "available", authenticated: false }, "claudeAgent")).toBe("signin");
  });

  it("driver, który nie raportuje logowania, nie jest przygaszany", () => {
    expect(instanceGate({ state: "available" }, "custom-ollama")).toBe("ok");
    expect(instanceGate({ state: "available", authenticated: true }, "claude")).toBe("ok");
  });
});
