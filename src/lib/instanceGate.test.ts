import { describe, expect, it } from "vitest";

import { instanceGate } from "./instanceGate";

describe("instanceGate", () => {
  it("brak CLI to zawsze 'missing', nawet gdy snapshot niesie authenticated", () => {
    expect(instanceGate({ state: "unavailable" }, "gemini")).toBe("missing");
    expect(instanceGate({ state: "unavailable", authenticated: true }, "grok")).toBe("missing");
  });

  it("CLI jest, ale nikt się nim nie zalogował → 'signin'", () => {
    // Gemini 0.59 i Qwen 0.23 na telefonie Kacpra: zainstalowane i autoaktualizowane,
    // bez oauth_creds.json i bez klucza w env.
    expect(instanceGate({ state: "available", authenticated: false }, "gemini")).toBe("signin");
    expect(instanceGate({ state: "available", authenticated: false }, "qwen")).toBe("signin");
    expect(instanceGate({ state: "available", authenticated: false }, "kimi")).toBe("signin");
    expect(instanceGate({ state: "available", authenticated: false }, "grok")).toBe("signin");
  });

  it("OpenCode zostaje otwarty bez klucza — Zen free chodzi anonimowo", () => {
    expect(instanceGate({ state: "available", authenticated: false }, "opencode")).toBe("ok");
  });

  it("driver, który nie raportuje logowania, nie jest przygaszany", () => {
    expect(instanceGate({ state: "available" }, "custom-ollama")).toBe("ok");
    expect(instanceGate({ state: "available", authenticated: true }, "claude")).toBe("ok");
  });
});
