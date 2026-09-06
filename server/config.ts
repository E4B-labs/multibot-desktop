// Config + data dirs. One file, ~/.openmausbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"key":"ck_…"}, "box": {"token":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { chmodSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";
// multibot (F7): własne serwery MCP użytkownika mieszkają w tym samym pliku co
// jego klucze API — patrz `server/mcp-connectors.ts` (import wyłącznie typów,
// więc cyklu w runtime nie ma).
import type { McpConnector } from "./mcp-connectors.ts";
// multibot: kształt reguł autoweryfikacji mieszka w server/auto-verify.ts (jw.
// — import wyłącznie typu).
import type { AutoVerifyState } from "./auto-verify.ts";

// multibot (U28): zarejestrowane tokeny powiadomień push (Expo) na telefon.
// Klucz = id urządzenia nadane przez aplikację mobilną.
export interface PushDevice {
  token: string;
  botId?: string;
  /** v2 account owner; absent only for legacy migration records. */
  userId?: string;
  updated: number;
}

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** Shared OpenCode Go key. Never returned by /api/config. */
  opencode?: { key?: string };
  /** key = ck_… Connect consumer key (connections + agent tools);
   * apiKey = ak_… project API key — optional, unlocks the full toolkit
   * catalog with official logos in the plugins marketplace. */
  composio?: { key?: string; apiKey?: string; url?: string };
  box?: { token?: string };
  voice?: { key?: string };
  /** The person using the app (collected in onboarding, shown in the
   * sidebar). Not a secret — echoed back by GET /api/config. */
  profile?: { name?: string; email?: string };
  // multibot (G1): model settings stay beside the existing instance envelope;
  // instanceConfigs translates them into the driver's opaque config.
  instances?: Record<string, InstanceConfig & { model?: { default?: string; baseUrl?: string } }>;
  // multibot (F7): id → konektor MCP użytkownika (tokeny w `env`/`headers`).
  mcpConnectors?: Record<string, Omit<McpConnector, "id">>;
  /** One self-hosted server is one workspace. */
  workspace?: { id?: string; name?: string };
  /** multibot (U28): tokeny powiadomień push (Expo) na telefon, obok sesji. */
  pushDevices?: Record<string, PushDevice>;
  /** multibot: strefa czasowa IANA ("Europe/Warsaw"), którą prompt bota podaje
   * modelowi. Pusty ciąg albo brak = strefa hosta, więc ktoś, kto nigdy tu nie
   * zajrzy, i tak dostaje bota z poprawną godziną. */
  timeZone?: string;
  /** multibot: autoweryfikacja akcji — patrz server/auto-verify.ts. */
  autoVerify?: AutoVerifyState;
  /** multibot: kolejność sekcji sidebaru. Trzymana na serwerze, żeby desktop
   * i telefon układały listę tak samo; nowe sekcje dopisują się na końcu. */
  sectionOrder?: string[];
}

/** Credential names shared with Electron diagnostics redaction. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "OMB_TTS_KEY",
  "OMB_OPENAI_IMAGE_KEY",
  "COMPOSIO_API_KEY",
  "OMB_COMPOSIO_BROKER_TOKEN",
] as const;

// Tests, Termux and packaged hosts may provide an explicit writable data root.
// Default stays compatible with existing desktop installations.
export const DATA_DIR = process.env.OMB_DATA_DIR?.trim() || join(homedir(), ".openmausbot");
const LEGACY_DATA_DIR = join(homedir(), ".opengrokbot");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

function chmodPrivate(path: string, mode: number): void {
  if (process.platform !== "win32" && existsSync(path)) chmodSync(path, mode);
}

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
    try {
      renameSync(LEGACY_DATA_DIR, DATA_DIR);
    } catch {
      /* cross-device or busy — fall through to a fresh dir */
    }
  }
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodPrivate(dir, 0o700);
  }
  chmodPrivate(join(DATA_DIR, "config.json"), 0o600);
}

/** multibot: wpisy `driver: "slafy"` to modele skonfigurowane przez
 * użytkownika sprzed usunięcia silnika Hermesa. Przepisujemy je na wejściu na
 * `openaiCompatible` — i tu, i we `instanceConfigs()`, bo trasy
 * `/api/models/custom` patrzą na `cfg.instances`, a flota na wynik
 * `instanceConfigs()`. Plik na dysku zostaje nietknięty do pierwszego zapisu. */
function migrateLegacyDrivers<T extends NonNullable<AppConfig["instances"]>>(instances: T): T {
  return Object.fromEntries(
    Object.entries(instances).map(([id, entry]) => [
      id,
      entry.driver === "slafy" ? { ...entry, driver: "openaiCompatible" } : entry,
    ]),
  ) as T;
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
  } catch {
    /* first run — env fallbacks below */
  }
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.opencode = { key: process.env.OPENCODE_API_KEY, ...cfg.opencode };
  cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.voice = { key: process.env.OMB_TTS_KEY, ...cfg.voice };
  if (cfg.instances) cfg.instances = migrateLegacyDrivers(cfg.instances);
  return cfg;
}

/** Merge a partial config into ~/.openmausbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: Record<string, unknown> = {};
  try {
    disk = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* first write */
  }
  // multibot (F7): `mcpConnectors` dołącza do listy — merge po kluczu, więc
  // zapis jednego konektora nie kasuje reszty, a `undefined` w wartości kasuje
  // wpis (JSON.stringify pomija takie pole).
  // multibot: `auth`, `firebase` i `deviceSessions` (stare szyny logowania) są
  // celowo poza listą — pliki na dysku zostają nietknięte, serwer ich nie czyta.
  for (const key of [
    "xai",
    "opencode",
    "composio",
    "box",
    "voice",
    "profile",
    "workspace",
    "mcpConnectors",
    "pushDevices",
    "autoVerify",
  ] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  // multibot (G1): callers replace the complete instance map. This makes
  // DELETE real (object merge cannot remove an instance) while preserving all
  // unrelated top-level config and secrets.
  if (patch.instances !== undefined) disk.instances = patch.instances;
  // multibot: `timeZone` jest stringiem, a pętla wyżej scala wyłącznie obiekty
  // — bez tej linii zapis przepadłby po cichu. O zapisie decyduje TYP, nie
  // prawdziwość: pusty ciąg to świadome "wykryj strefę sam", a nie brak wyboru.
  if (typeof patch.timeZone === "string") disk.timeZone = patch.timeZone;
  // multibot: kolejność sekcji to lista, nie obiekt — pętla wyżej by ją minęła,
  // a scalanie i tak byłoby złe: klient przysyła pełną, nową kolejność.
  if (Array.isArray(patch.sectionOrder)) disk.sectionOrder = patch.sectionOrder;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  chmodPrivate(DATA_DIR, 0o700);
  chmodPrivate(p, 0o600);
  writeFileSync(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
  chmodPrivate(p, 0o600);
}

// multibot (G1): stable built-in ids double as reserved custom-model ids and
// the allow-list for CLI toggles. `computer` is not a command-line tool.
export const DEFAULT_INSTANCE_CONFIGS = {
  grok: { driver: "grokAgent" },
  gemini: { driver: "geminiAgent" },
  // multibot (G3): official ACP stdio CLIs.
  kimi: { driver: "kimiAgent" },
  qwen: { driver: "qwenAgent" },
  claude: { driver: "claudeAgent" },
  codex: { driver: "codex" },
  opencode: { driver: "opencode", displayName: "OpenCode" },
  // multibot (A5): `computer` (box.ascii.dev, boxAgent) celowo usunięty z
  // domyślnej floty — MultiBot ma swój komputer (wspólny pulpit na hoście,
  // integrations.localComputer), a ta instancja tylko pokazywała w model
  // pickerze "Computer / no Box token". Własny wpis `instances.computer`
  // w configu przywróci boxa każdemu, kto go chce.
} satisfies InstanceConfigMap;
// multibot (G3): Kimi/Qwen share the same durable allow switch API.
export const BUILT_IN_CLI_IDS = ["grok", "gemini", "claude", "codex", "kimi", "qwen", "opencode"] as const;

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  // multibot (G1): configured instances are an overlay, never a replacement;
  // adding one custom model must not erase the built-in CLI fleet.
  const map: InstanceConfigMap = {};
  const configuredInstances: NonNullable<AppConfig["instances"]> = {
    ...DEFAULT_INSTANCE_CONFIGS,
    ...migrateLegacyDrivers(cfg.instances ?? {}),
  };
  for (const [id, configured] of Object.entries(configuredInstances)) {
    // Legacy credential storage used a visible custom-model instance. Keep its key
    // readable below, but never expose a second OpenCode rail entry.
    if (id === "opencodeGo") continue;
    const model = configured.model;
    const entry: InstanceConfig = {
      ...configured,
      ...(configured.driver === "openaiCompatible" && model
        ? { config: { ...((configured.config as object | undefined) ?? {}), model } }
        : {}),
    };
    entry.environment = {
      ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...entry.environment,
    };
    if (id === "opencode") {
      const legacyKey = cfg.instances?.opencodeGo?.environment?.OPENAI_API_KEY;
      const key = cfg.opencode?.key !== undefined ? cfg.opencode.key : legacyKey;
      if (key) entry.environment.OPENCODE_API_KEY = key;
      else delete entry.environment.OPENCODE_API_KEY;
    }
    map[id] = entry;
  }
  return map;
}
