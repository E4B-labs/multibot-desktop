// multibot (F7): rejestr WŁASNYCH serwerów MCP użytkownika — obok Composio,
// nie zamiast. Composio zostaje primary (marketplace OAuth-owy, katalog z API);
// tu ląduje to, czego w nim nie ma: firmowy serwer MCP, lokalny stdio, cudzy
// endpoint HTTP z własnym tokenem.
//
// Ten sam kształt API co `composio.ts` — katalog / lista / podłącz / odłącz —
// żeby trasy `/api/connectors/*` w `index.ts` wyglądały tak samo dla obu źródeł.
//
// STORE: `~/.multibot/config.json`, klucz `mcpConnectors` (mapa po id). Jeden
// store, ten sam, w którym leżą klucze API użytkownika — tokeny konektorów
// (`env`, `headers`) są dokładnie tej samej klasy sekretem i nie ma powodu
// zakładać im drugiego pliku.
import { loadConfig, saveConfig, type AppConfig } from "./config.ts";

export interface StdioTransport {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface HttpTransport {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}
export interface McpConnector {
  id: string;
  name: string;
  transport: StdioTransport | HttpTransport;
}

// Id ląduje w nazwie serwera MCP, więc zostaje przy dotychczasowym regeksie —
// o jeden znak krótszym niż 64, żeby zmieścił się też z prefiksem `mb-`.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
// Nazwy montowane przez drivery same z siebie — konektor o takim id po cichu
// przykryłby (albo dał się przykryć) integracji harnessu.
const RESERVED = new Set(["composio", "computer", "agents", "ogb"]);

function str(value: unknown, what: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new Error(`connector: ${what} required`);
  return s;
}

function strMap(value: unknown, what: string): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`connector: ${what} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as object)) out[k] = String(v);
  return Object.keys(out).length ? out : undefined;
}

/** Waliduje wsad z HTTP i zwraca konektor gotowy do zapisu. Rzuca na złym. */
export function decodeConnector(id: string, raw: unknown): McpConnector {
  if (!ID_RE.test(id)) throw new Error(`connector: invalid id ${JSON.stringify(id)} (expected ${ID_RE.source})`);
  if (RESERVED.has(id)) throw new Error(`connector: id ${id} is reserved by a built-in integration`);
  const o = (raw ?? {}) as Record<string, any>;
  const t = (o.transport ?? {}) as Record<string, any>;
  const kind = t.type === "stdio" || t.type === "sse" ? t.type : t.url || t.type === "http" ? "http" : "stdio";
  const transport: McpConnector["transport"] =
    kind === "stdio"
      ? {
          type: "stdio",
          command: str(t.command, "transport.command"),
          ...(Array.isArray(t.args) && t.args.length ? { args: t.args.map(String) } : {}),
          ...(strMap(t.env, "transport.env") ? { env: strMap(t.env, "transport.env") } : {}),
        }
      : {
          type: kind,
          url: str(t.url, "transport.url"),
          ...(strMap(t.headers, "transport.headers") ? { headers: strMap(t.headers, "transport.headers") } : {}),
        };
  if (transport.type !== "stdio" && !/^https?:\/\//i.test(transport.url)) {
    throw new Error("connector: transport.url must be http(s)");
  }
  return { id, name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : id, transport };
}

/** Wszystkie konektory użytkownika, posortowane po id (stabilny podpis). */
export function connectors(cfg: AppConfig = loadConfig()): McpConnector[] {
  return Object.entries(cfg.mcpConnectors ?? {})
    .filter(([, spec]) => spec && typeof spec === "object")
    .map(([id, spec]) => ({ id, name: spec.name || id, transport: spec.transport }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Wpis katalogu integracji — ten sam kształt karty co `composio.ToolkitCard`. */
export function connectorCards(cfg: AppConfig = loadConfig()) {
  return connectors(cfg).map((c) => ({
    slug: c.id,
    label: c.name,
    blurb:
      c.transport.type === "stdio"
        ? `stdio: ${[c.transport.command, ...(c.transport.args ?? [])].join(" ")}`.slice(0, 90)
        : `${c.transport.type}: ${c.transport.url}`.slice(0, 90),
    logo: null as string | null,
  }));
}

/** Podłącz (albo nadpisz) konektor. Zwraca zapisany wpis. */
export function saveConnector(id: string, raw: unknown): McpConnector {
  const connector = decodeConnector(id, raw);
  saveConfig({ mcpConnectors: { [id]: { name: connector.name, transport: connector.transport } } });
  return connector;
}

/** Odłącz konektor. Brak wpisu = no-op. */
export function removeConnector(id: string): void {
  // `saveConfig` merguje po kluczu najwyższego poziomu, więc kasowanie idzie
  // przez `undefined`: JSON.stringify wyrzuca takie pole z zapisywanego pliku.
  saveConfig({ mcpConnectors: { [id]: undefined } } as unknown as Partial<AppConfig>);
}
