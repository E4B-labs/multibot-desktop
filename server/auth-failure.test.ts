import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authFailure, cliToolIdFor, loginExpiredNote } from "./auth-failure.ts";

// multibot: tabela zamiast reguł per-dostawca. Nowy harness dopisuje tu wiersz,
// nie gałąź w kodzie — a negatywy pilnują dwóch rzeczy: żeby „token" z
// kompilatora nie wywoływał okna logowania i żeby cudza odmowa dostępu (git,
// MCP, npm) w ogonie stderr nie wyglądała jak wygasła sesja CLI.
const MATCHES: [string, string | undefined][] = [
  // claude — dokładny tekst z transkryptu 10.09.2026
  ["claude exited 1 before result: Failed to authenticate: OAuth session expired and could not be refreshed", "claude"],
  ["Failed to authenticate: OAuth session expired and could not be refreshed", undefined],
  // codex
  ["codex: request failed with status 401 Unauthorized", "codex"],
  ["stream error: your access token expired, run `codex login`", "codex"],
  // opencode / acp — klasy błędów ACP jadą do powłoki dosłownie
  ["opencode: not logged in", "opencode"],
  ["ProviderAuthError: session for anthropic is no longer valid", undefined],
  ["Error: authentication required", undefined],
  // grok i reszta rodziny
  ["grok: invalid api key", "grok"],
  ["gemini: credentials missing, please sign in", "gemini"],
  ["Please log in to continue", undefined],
  ["session invalid — re-authenticate", undefined],
];

const NEGATIVES = [
  // kompilator mówiący o tokenach (JWT, parser) — NIE jest to wygasłe logowanie
  "SyntaxError: Invalid or unexpected token",
  "src/jwt.ts(12,3): error TS2339: Property 'token' does not exist on type 'Session'",
  "TypeError: Cannot read properties of undefined (reading 'token')",
  "token limit exceeded: 200000 tokens used",
  "Failed to count tokens for this request",
  "rate limit exceeded, retry in 30s",
  // CUDZA odmowa dostępu w ogonie stderr: sesja samego CLI jest zdrowa
  "claude exited 1 before result: fatal: Authentication failed for 'https://github.com/acme/app.git/'",
  'claude exited 1 before result: MCP server "linear" failed: Authorization header is badly formatted',
  "npm ERR! code E401 npm ERR! Incorrect or missing password",
  // zwykłe awarie tury
  "spawn failed: ENOENT",
  "claude worker gave no sign of life, also after a restart",
  "bash blocked by bot permissions",
  "Error: request failed with status 500",
  // samo „401" bez słowa o logowaniu to liczba, nie odmowa dostępu
  "401 files changed",
  "401",
  "",
];

describe("authFailure", () => {
  for (const [text, tool] of MATCHES) {
    it(`rozpoznaje: ${text.slice(0, 60) || "(puste)"}`, () => {
      const hit = authFailure(text);
      expect(hit, text).not.toBeNull();
      expect(hit?.tool).toBe(tool);
    });
  }

  for (const text of NEGATIVES) {
    it(`przepuszcza: ${text.slice(0, 60) || "(puste)"}`, () => {
      expect(authFailure(text), text).toBeNull();
    });
  }

  it("treść dla needsAttention niesie nazwę narzędzia", () => {
    expect(loginExpiredNote("claude")).toBe("Login expired for claude. Sign in again to continue.");
  });
});

describe("cliToolIdFor", () => {
  it("bot na harnessie CLI daje jego id", () => {
    expect(cliToolIdFor({ modelSelection: { instanceId: "codex" } })).toBe("codex");
  });

  it("bot na własnym modelu HTTP nie ma czego odświeżać", () => {
    expect(cliToolIdFor({ modelSelection: { instanceId: "my-vllm" } })).toBeNull();
    expect(cliToolIdFor({})).toBeNull();
  });
});

// Matcher bez podpięcia jest martwy: `runtime.error` to JEDYNE miejsce, przez
// które przechodzą awarie WSZYSTKICH driverów.
describe("podpięcie w serwerze", () => {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("wisi na wspólnej obsłudze runtime.error", () => {
    expect(index).toContain("authFailure(event.message)");
    expect(index).toContain("needsAttention: note");
    expect(index).toContain('pushForBot(bot.id, "attention"');
    expect(index).toContain('broadcast({ kind: "auth-expired"');
  });

  it("harness bota ma pierwszeństwo przed nazwą wyłowioną z tekstu", () => {
    expect(index).toContain("cliToolIdFor(bot) ?? expired.tool");
  });

  it("prywatny bot nie rozsyła swojej prośby całemu workspace'owi", () => {
    expect(index).toContain('if (event.kind === "auth-expired") return canReadBot(botFor(event.botId), actor);');
  });

  it("udane logowanie gasi prośbę bez czekania na następną turę", () => {
    expect(index).toContain("clearLoginExpired(tool.id)");
  });
});
