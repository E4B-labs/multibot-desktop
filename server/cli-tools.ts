// multibot (G3): documented, non-elevated install commands. UI may show the
// exact command when permissions fail; server never falls back to sudo/admin.
export interface CliInstall {
  command: string;
  args: string[];
}

export interface CliToolMetadata {
  id: string;
  driverKind: string;
  displayName: string;
  install?: CliInstall;
  /** Uses a packaged native installer script with Termux/proot fallback. */
  installStrategy?: "claude-native" | "codex-native" | "kimi-native" | "opencode-native";
  /** Interactive OAuth/subscription login; never automated by server. */
  loginCommand?: string;
  /** Fixed interactive command; stdin stays attached for OAuth prompts. */
  login?: CliInstall;
  /** Device flow prints URL/code and polls; user enters code in browser. */
  loginMode?: "stdin" | "device";
  /** Krótka instrukcja dla interaktywnego logowania konkretnego CLI. */
  loginHint?: string;
}

export const CLI_TOOLS: readonly CliToolMetadata[] = [
  {
    id: "grok",
    driverKind: "grokAgent",
    displayName: "Grok",
    // Wyświetlane, nigdy uruchamiane — dystrybucja Grok Build zmienia się
    // niezależnie, ale samo polecenie logowania jest stabilne (drivers/acp/grok.ts).
    loginCommand: "grok login",
    // Grok Build distribution changes independently; detection stays, but no
    // guessed package command is executed.
  },
  {
    id: "gemini",
    driverKind: "geminiAgent",
    displayName: "Gemini",
    loginCommand: "gemini",
    login: { command: "gemini", args: [] },
    loginHint: "Wybierz „Sign in with Google”. Nie ustawiaj GEMINI_API_KEY, jeśli używasz subskrypcji.",
    install: { command: "npm", args: ["install", "-g", "@google/gemini-cli@latest"] },
  },
  {
    id: "claude",
    driverKind: "claudeAgent",
    displayName: "Claude Code",
    installStrategy: "claude-native",
    // Official non-TTY flow: prints OAuth URL and accepts pasted callback code
    // on stdin. `/login` belongs to the interactive REPL and is unavailable
    // when the harness owns stdin through HTTP.
    loginCommand: "claude auth login",
    login: { command: "claude", args: ["auth", "login"] },
    install: { command: "npm", args: ["install", "-g", "@anthropic-ai/claude-code@latest"] },
  },
  {
    id: "codex",
    driverKind: "codex",
    displayName: "Codex",
    installStrategy: "codex-native",
    // Official non-TTY OAuth: output carries URL + one-time code, then CLI
    // polls until browser authorization completes. No token crosses harness.
    loginCommand: "codex login --device-auth",
    login: { command: "codex", args: ["login", "--device-auth"] },
    loginMode: "device",
    install: { command: "npm", args: ["install", "-g", "@openai/codex@latest"] },
  },
  {
    id: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    loginCommand: "kimi",
    login: { command: "kimi", args: [] },
    installStrategy: "kimi-native",
    loginHint: "W CLI wpisz /login i wybierz Kimi Code OAuth.",
  },
  {
    id: "qwen",
    driverKind: "qwenAgent",
    displayName: "Qwen",
    loginCommand: "qwen",
    login: { command: "qwen", args: [] },
    loginHint: "W CLI wpisz /auth → Alibaba ModelStudio → Coding Plan.",
    install: { command: "npm", args: ["install", "-g", "@qwen-code/qwen-code@latest"] },
  },
  {
    id: "opencode",
    driverKind: "opencode",
    displayName: "OpenCode",
    // npm's opencode-ai has no Android build, so Termux needs the native script.
    installStrategy: "opencode-native",
    install: { command: "npm", args: ["install", "-g", "opencode-ai@latest"] },
    loginHint: "OpenCode Go needs a shared API key; free OpenCode Zen models need no key in MultiBot.",
  },
] as const;

export const installCommandText = (install: CliInstall | undefined) =>
  install ? [install.command, ...install.args].join(" ") : null;
