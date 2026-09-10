// Kimi Code official ACP stdio entrypoint: `kimi acp`.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";

export const kimiAcpArgs = (model?: string) => ["acp", ...(model ? ["-m", model] : [])];

const support: AcpSupport = {
  driverKind: "kimiAgent",
  displayName: "Kimi",
  // Kimi Code CLI (kimi-code, następca kimi-cli): realne modele z
  // kimi.com/code/docs/en/kimi-code/models — k3 / k3-256k (Kimi K3) oraz
  // kimi-for-coding / kimi-for-coding-highspeed (Kimi K2.7 Code).
  models: {
    default: "kimi-for-coding",
    options: [
      { id: "kimi-for-coding", label: "Kimi K2.7 Code" },
      { id: "kimi-for-coding-highspeed", label: "Kimi K2.7 Code HighSpeed" },
      { id: "k3", label: "Kimi K3 (1M)" },
      { id: "k3-256k", label: "Kimi K3 (256k)" },
    ],
  },
  defaultCli: "kimi",
  nativeSource: "kimi.acp",
  loginNote: "Kimi is not signed in — run `kimi` once to log in",
  spawnArgs: (_config, turn) => kimiAcpArgs(turn.model),
  pickAuthMethod: (methods) => methods.find((method) => typeof method.id === "string")?.id ?? null,
  authFailure: "continue",
  isAuthenticated: (env) =>
    Boolean(env.KIMI_API_KEY || env.MOONSHOT_API_KEY) || existsSync(join(env.HOME ?? homedir(), ".kimi", "config.toml")),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const KimiAgentDriver = createAcpDriver(support);
