// Gemini CLI harness support — Google's `gemini` CLI over ACP stdio
// (`gemini --experimental-acp`). Rides the generic runtime in acp/core.ts.
//
// Auth is intentionally lenient (authFailure "continue"): the Gemini CLI
// commonly runs off an ambient login — an OAuth session from a prior
// `gemini` run (~/.gemini/oauth_creds.json) or GEMINI_API_KEY in the env —
// so we attempt the advertised authenticate method but never hard-fail the
// turn on it, unlike Grok's subscription-bound cached_token.
//
// NOTE: untested against a live `gemini` CLI on this machine (not installed);
// the ACP flag + auth method ids follow the published Gemini CLI ACP contract
// and should be re-verified end-to-end once the CLI is present.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";

// Prefer personal OAuth, then an explicit key method, then Vertex — but fall
// back to whatever the CLI advertises so a new method id still works.
const AUTH_PREFERENCE = ["oauth-personal", "gemini-api-key", "vertex-ai"];

const support: AcpSupport = {
  driverKind: "geminiAgent",
  displayName: "Gemini",
  models: {
    default: "gemini-3.6-flash",
    options: [
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
    ],
  },
  defaultCli: "gemini",
  nativeSource: "gemini.acp",
  loginNote: "Gemini CLI is not signed in — run `gemini` once to log in, or set GEMINI_API_KEY",

  spawnArgs: (_config, turn) => ["--experimental-acp", ...(turn.model ? ["-m", turn.model] : [])],

  pickAuthMethod: (methods) => {
    const ids = methods.map((m) => m.id).filter((id): id is string => typeof id === "string");
    for (const pref of AUTH_PREFERENCE) if (ids.includes(pref)) return pref;
    return ids[0] ?? null;
  },
  authFailure: "continue",

  isAuthenticated: (env) =>
    Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY) ||
    existsSync(join(env.HOME ?? homedir(), ".gemini", "oauth_creds.json")),

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const GeminiAgentDriver = createAcpDriver(support);
