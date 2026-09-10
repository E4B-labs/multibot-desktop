// multibot: "test connection" dla własnego serwera MCP użytkownika.
//
// Robi dokładnie to, co zrobi driver przy pierwszej turze — handshake MCP
// (`initialize` → `notifications/initialized` → `tools/list`) — tyle że raz,
// z limitem czasu i bez tury. Dzięki temu panel mówi „działa, 12 narzędzi"
// ZANIM konektor pojedzie do bota, zamiast zostawiać użytkownika z cichym
// brakiem narzędzi w rozmowie.
//
// Bez SDK: repo nie ma `@modelcontextprotocol/sdk` i nie dokładamy zależności
// dla trzech ramek JSON-RPC. stdio to JSON po liniach (MCP NIE używa tu
// `Content-Length`), HTTP to streamable-HTTP — ciało JSON albo linie SSE
// `data: {…}`, tak jak parsuje je `composio.ts`.
//
// Nic stąd nie rzuca: każda awaria (ENOENT, 401, timeout, śmieci na stdout)
// wychodzi jako `{ok:false, error}` — bo to WYNIK testu, nie błąd serwera.
// Sekrety (`transport.env`, `transport.headers`) nigdy nie trafiają do
// `error`: serwer MCP potrafi wypluć swój token na stderr, więc tekst idzie
// przez `redactor()`.
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { augmentedPath, resolveCliSpawn } from "./env-path.ts";
import { killTree } from "./kill-tree.ts";
import type { HttpTransport, StdioTransport } from "./mcp-connectors.ts";

export type ProbeResult =
  | { ok: true; tools: string[]; serverName?: string }
  | { ok: false; error: string };

const PROTOCOL_VERSION = "2025-06-18";
// Serwer z tysiącem narzędzi nie ma prawa rozdmuchać odpowiedzi API.
const MAX_TOOLS = 200;
const MAX_ERROR = 300;

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "multibot", version: "1" },
  },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

/** Zamazuje wartości sekretów konektora w dowolnym tekście diagnostycznym.
 * Defensywny, bo wpis w `config.json` bywa ręcznie pisany: sam redaktor nie ma
 * prawa wywrócić sondy, której cały kontrakt brzmi „nigdy nie rzuca". */
function redactor(transport: StdioTransport | HttpTransport): (text: string) => string {
  let secrets: string[] = [];
  try {
    const bag = (transport as StdioTransport).env ?? (transport as HttpTransport).headers ?? {};
    secrets = Object.values(bag).map(String).filter(Boolean);
  } catch {
    /* nie-obiekt w configu — nie ma czego zamazywać */
  }
  return (text: string) => secrets.reduce((acc, secret) => acc.split(secret).join("…"), text);
}

function short(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `no answer within ${timeoutMs} ms`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (message || "failed").slice(0, MAX_ERROR);
}

function rpcError(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown };
  return String(e?.message ?? `JSON-RPC error ${e?.code ?? "?"}`).slice(0, MAX_ERROR);
}

/** `{ok:true, …}` z wyniku `initialize` + `tools/list`. */
function shape(init: unknown, list: unknown): ProbeResult {
  const tools = (list as { tools?: unknown })?.tools;
  const names = (Array.isArray(tools) ? tools : [])
    .map((t) => String((t as { name?: unknown })?.name ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_TOOLS);
  const serverName = (init as { serverInfo?: { name?: unknown } })?.serverInfo?.name;
  return {
    ok: true,
    tools: names,
    ...(typeof serverName === "string" && serverName.trim() ? { serverName: serverName.trim() } : {}),
  };
}

/** Ciało streamable-HTTP: goły JSON albo SSE. Zwraca `result` DLA TEGO id,
 * rzuca na `error`. Po id, nie po pierwszej linii `data:` — przed wynikiem
 * potrafi lecieć postęp albo log, a wzięcie ich za odpowiedź dawało „działa,
 * 0 narzędzi" na zdrowym serwerze. */
function parseRpc(text: string, id: number): unknown {
  const frames = text.trimStart().startsWith("{")
    ? [text]
    : text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  if (!frames.length) throw new Error("empty MCP response");
  for (const frame of frames) {
    let msg: { id?: unknown; error?: unknown; result?: unknown };
    try {
      msg = JSON.parse(frame);
    } catch {
      continue;
    }
    if (String(msg.id) !== String(id)) continue;
    if (msg.error) throw new Error(rpcError(msg.error));
    return msg.result ?? null;
  }
  throw new Error("no MCP answer to the request");
}

// ponytail: `type:"sse"` idzie tą samą trasą co streamable-HTTP (POST na url).
// Dzisiejsze serwery tak właśnie działają; STARY transport HTTP+SSE (GET po
// stream, potem zdarzenie `endpoint`) zgłosi się tu jako 405/404 — jeśli ktoś
// taki serwer podłączy, dopisać handshake GET, nie zgadywać.
async function probeHttp(transport: HttpTransport, timeoutMs: number): Promise<ProbeResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  // Część serwerów przypina sesję do nagłówka `mcp-session-id` z odpowiedzi na
  // `initialize` i odrzuca kolejne wywołania bez niego.
  let session = "";
  const post = async (message: unknown, expectId: number | null): Promise<unknown> => {
    const res = await fetch(transport.url, {
      method: "POST",
      headers: {
        ...(transport.headers ?? {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(message),
      signal,
    });
    session = res.headers.get("mcp-session-id") || session;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    return expectId === null ? null : parseRpc(text, expectId);
  };
  const init = await post(INITIALIZE, INITIALIZE.id);
  await post(INITIALIZED, null); // 202, bez ciała
  return shape(init, await post(TOOLS_LIST, TOOLS_LIST.id));
}

function probeStdio(transport: StdioTransport, timeoutMs: number): Promise<ProbeResult> {
  // Ta sama rozwiązywalność co drivery: na Windowsie `npx`/`.cmd` to nie plik
  // wykonywalny, więc idzie przez `resolveCliSpawn`, nie przez `shell:true`.
  const spawned = resolveCliSpawn(transport.command, transport.args ?? []);
  const clean = redactor(transport);
  // HOME jawnie: serwery MCP odpalane przez CLI pod prootem dostawały HOME=/root
  // i szukały swojej konfiguracji w cudzym katalogu.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: augmentedPath(),
    HOME: homedir(),
    ...(transport.env ?? {}),
  };
  const child = spawn(spawned.command, spawned.args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsVerbatimArguments: spawned.windowsVerbatimArguments,
    windowsHide: true,
    // grupa procesów = killTree ubija też to, co serwer sam odpalił
    detached: process.platform !== "win32",
  });
  // Awaria zapisu na stdin przychodzi ZDARZENIEM, nie wyjątkiem: bez tego
  // listenera EPIPE po serwerze, który padł od razu, przewraca cały harness.
  child.stdin?.on("error", () => {});
  child.stdout?.setEncoding("utf8"); // znak UTF-8 pocięty między chunkami = zgubiona ramka
  child.stderr?.setEncoding("utf8");

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let init: unknown = null;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child); // ZAWSZE — także na sukcesie: sonda nie zostawia procesu
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${timeoutMs} ms` }), timeoutMs);
    timer.unref?.();
    const send = (message: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        /* proces już nie żyje — `error`/`exit` zaraz to zgłosi */
      }
    };

    child.on("error", (error) => finish({ ok: false, error: clean(short(error, timeoutMs)) }));
    // `close`, nie `exit`: serwer, który odpowiada i od razu kończy, ma jeszcze
    // swoją odpowiedź w buforze stdout, gdy `exit` już leci.
    child.on("close", (code, signal) => {
      const tail = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      finish({ ok: false, error: clean(`server stopped (${how})${tail ? `: ${tail}` : ""}`).slice(0, MAX_ERROR) });
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      let nl: number;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: unknown; error?: unknown; result?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // serwery lubią logować po stdout — ignorujemy nie-JSON
        }
        if (msg.error && (msg.id === 1 || msg.id === 2)) return finish({ ok: false, error: clean(rpcError(msg.error)) });
        if (msg.id === 1) {
          init = msg.result;
          send(INITIALIZED);
          send(TOOLS_LIST);
        } else if (msg.id === 2) {
          return finish(shape(init, msg.result));
        }
      }
      // Bufor rośnie tylko o NIEDOKOŃCZONĄ linię — pełne ramki są już zjedzone
      // wyżej. 1 MB bez jednego `\n` to nie serwer MCP, to zwykły program.
      // (Nie ucinać po długości bufora: `tools/list` z setką narzędzi i ich
      // schematami bywa grubo ponad 64 KB i przyszedłby obcięty.)
      if (stdout.length > 1_048_576) stdout = "";
    });
    send(INITIALIZE);
  });
}

/**
 * Jednorazowy handshake z serwerem MCP. Zwraca nazwy narzędzi albo powód
 * porażki — nigdy nie rzuca i nigdy nie zostawia dziecka przy życiu.
 */
export async function probeMcp(
  transport: StdioTransport | HttpTransport,
  timeoutMs = 15_000,
): Promise<ProbeResult> {
  const clean = redactor(transport);
  try {
    return transport.type === "stdio"
      ? await probeStdio(transport, timeoutMs)
      : await probeHttp(transport, timeoutMs);
  } catch (error) {
    return { ok: false, error: clean(short(error, timeoutMs)) };
  }
}
