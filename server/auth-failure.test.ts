import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authFailure, loginExpiredNote } from "./auth-failure.ts";

// multibot: tabela zamiast reguł per-dostawca. Nowy harness dopisuje tu wiersz,
// nie gałąź w kodzie — a negatywy pilnują, żeby „token" z kompilatora nie
// wywoływał okna logowania.
const MATCHES: [string, string | undefined][] = [
  // claude — dokładny tekst z transkryptu 10.09.2026
  ["claude exited 1 before result: Failed to authenticate: OAuth session expired and could not be refreshed", "claude"],
  ["Failed to authenticate: OAuth session expired and could not be refreshed", undefined],
  // codex
  ["codex: request failed with status 401 Unauthorized", "codex"],
  ["stream error: your access token expired, run `codex login`", "codex"],
  // opencode / acp
  ["opencode: not logged in", "opencode"],
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
  "rate limit exceeded, retry in 30s",
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

  it("treść dla needsAttention niesie nazwę narzędzia i prowadzi do ustawień", () => {
    expect(loginExpiredNote("claude")).toBe("Login expired for claude. Refresh it in Settings → CLI tools.");
  });

  // Matcher bez podpięcia jest martwy: `runtime.error` to JEDYNE miejsce, przez
  // które przechodzą awarie WSZYSTKICH driverów.
  it("podpięty pod wspólną obsługę runtime.error", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain("const expired = authFailure(event.message);");
    expect(index).toContain("store.patchBot(bot.id, { needsAttention: note });");
    expect(index).toContain('pushForBot(bot.id, "attention", note);');
    expect(index).toContain('broadcast({ kind: "auth-expired", tool: expiredTool, botId: bot.id, message: note });');
    // prywatny bot nie rozsyła swojej prośby całemu workspace'owi
    expect(index).toContain('if (event.kind === "auth-expired") return canReadBot(botFor(event.botId), actor);');
  });
});
