// Qwen Code official stable ACP stdio entrypoint: `qwen --acp`.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";

export const qwenAcpArgs = (model?: string) => ["--acp", ...(model ? ["--model", model] : [])];

// `OPENAI_API_KEY` NIE jest dowodem zalogowania Qwena — tej nazwy używa driver
// openaiCompatible (drivers/grok.ts) i połowa narzędzi na maszynie. Klucz OpenAI
// w env meldował Qwena jako zalogowanego, więc picker świecił na zielono, a tura
// i tak padała na CLI.
export const qwenIsAuthenticated = (env: Record<string, string | undefined>, home = homedir()): boolean => {
  if (env.QWEN_API_KEY || env.DASHSCOPE_API_KEY) return true;
  if (existsSync(join(home, ".qwen", "oauth_creds.json"))) return true;
  try {
    const settings = JSON.parse(readFileSync(join(home, ".qwen", "settings.json"), "utf8")) as {
      security?: { auth?: { selectedType?: unknown } };
    };
    return typeof settings.security?.auth?.selectedType === "string";
  } catch {
    return false;
  }
};

// Qwen Code (qwen-code): realne modele z qwenlm.github.io/qwen-code-docs/
// en/users/configuration/auth/ — Alibaba Cloud Coding Plan (qwen OAuth
// wyłączony 2026-04-15; wymagany klucz sk-sp- lub API key). Zalecany default
// to qwen3-coder-plus; reszta to modele Coding Plan Qwen.
const support: AcpSupport = {
  driverKind: "qwenAgent",
  displayName: "Qwen",
  models: {
    default: "qwen3-coder-plus",
    options: [
      { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" },
      { id: "qwen3-coder-next", label: "Qwen3 Coder Next" },
      { id: "qwen3.5-plus", label: "Qwen3.5 Plus" },
      { id: "qwen3.6-plus", label: "Qwen3.6 Plus" },
      { id: "qwen3.7-plus", label: "Qwen3.7 Plus" },
      { id: "qwen3-max-2026-01-23", label: "Qwen3 Max (2026-01-23)" },
    ],
  },
  defaultCli: "qwen",
  nativeSource: "qwen.acp",
  loginNote: "Qwen is not signed in — run `qwen` once to log in",
  spawnArgs: (_config, turn) => qwenAcpArgs(turn.model),
  pickAuthMethod: (methods) => methods.find((method) => typeof method.id === "string")?.id ?? null,
  authFailure: "continue",
  isAuthenticated: (env) => qwenIsAuthenticated(env),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const QwenAgentDriver = createAcpDriver(support);
