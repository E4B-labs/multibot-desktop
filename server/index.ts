// MultiBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { botSystemPrompt } from "./bot-prompt.ts";
// multibot: autoweryfikacja — filtr na prośbach o zgodę, patrz server/auto-verify.ts.
import { decideAction, normalizeAutoVerify, type AutoVerifyState } from "./auto-verify.ts";
import { fleetStatusBlock } from "./fleet-status.ts";
import {
  buildFleetEnvironment,
  fleetEnvironmentForBots,
  FLEET_ENVIRONMENT_REFRESH_MS,
  type FleetEnvironment,
} from "./fleet-environment.ts";
import * as box from "./box.ts";
import { AttachmentStore, MAX_FILE_BYTES, resolveBotFile } from "./attachments.ts";
import { adminOverview, recordTurnEvent } from "./admin.ts";
import { mountAuth, requestActor } from "./auth.ts";
import {
  IdentityError, IdentityStore, identityCookie, isIdentityPublicRoute,
  isLoopbackRequest, isSecureRequest,
  type IdentityActor, type CreatedSession,
} from "./identity.ts";
import { canBotContact, canManageBot, canReadBot } from "./acl.ts";
import * as composio from "./composio.ts";
// multibot (U28): powiadomienia push, gdy bot wchodzi w needsAttention.
import { registerPushDevice, notifyPushDevices } from "./push.ts";
import {
  BUILT_IN_CLI_IDS,
  DEFAULT_INSTANCE_CONFIGS,
  ensureDirs,
  instanceConfigs,
  loadConfig,
  saveConfig,
  DATA_DIR,
  EVENTS_DIR,
  NATIVE_DIR,
  type AppConfig,
} from "./config.ts";
import { newId, type ApprovalRuleCandidate, type RuntimeEvent } from "./contracts.ts";
import { CLI_TOOLS, installCommandText } from "./cli-tools.ts";
import { deviceInfo, deviceResources } from "./device.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { trimTranscript } from "./drivers/history.ts";
import { openCodeCatalog, startOpenCodeModelRefresh } from "./drivers/acp/opencode-catalog.ts";
// multibot (H1-H5): jeden komputer bota — kontener na czas życia bota.
import {
  dockerAvailable,
  ensureComputer,
  resumeComputer,
  exec as computerExec,
} from "./hosted-computer.ts";
import * as computerControl from "./computer-control.ts";
// multibot: the browser half of the computer — CDP tools and the teach recorder,
// back in the harness after the Python engine took them with it.
import { computerTool, computerToolset } from "./computer/index.ts";
import * as teach from "./computer/teach.ts";
import { filterSearchResults, searchText, type SearchResult } from "./search.ts";
import { promptWithReply, resolveReplyTarget } from "./replies.ts";
import { scoutProject } from "./project-scout.ts";
import { matchVncRoute, mountVncUpgrade, proxyVncHttp } from "./computer-vnc-proxy.ts";
import { broadcastWs, mountEventsWs } from "./events-ws.ts";
import { EventBus } from "./harness/bus.ts";
// multibot (F7): własne serwery MCP użytkownika obok Composio
import * as mcpConnectors from "./mcp-connectors.ts";
import * as googleWorkspace from "./google-workspace.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { HarnessRoutines, oneShotAt, routineTurnText, verifyWebhookSignature, type HarnessRoutine } from "./routines.ts";
import { GroupStore, groupMemberId, threadIdOfGroupMember } from "./group-store.ts";
import { budgetLeft, isAcknowledgement, isDuplicateOfLast, RoomStore, ROOM_DONE_MARKER, type RoomRecord } from "./rooms.ts";
import { GoalStore, GOAL_DONE_MARKER, goalThreadId, parseGoalCommand, type GoalRecord } from "./goals.ts";
import { jobProgress, SetupJobs } from "./setup-jobs.ts";
import { type TurnIntegrationsLike } from "./turn-tools.ts"; // multibot (A2): wyliczenie narzędzi tury w prompcie
import { BOT_COLORS, BOT_SHAPES, defaultSelectionTarget, managedBotPatch, mentionedBots, Store, type BotRecord, type ConnectorTarget, type Message, type OptionCardData } from "./store.ts";
import { CREDENTIAL_TARGETS, credentialConfigPatch, isCredentialTargetId, type CredentialTargetId } from "./credential-request.ts";
import { inspectorEvents, recordInspectorEvent, replayInspectorEvents } from "./inspector.ts";
import { WorkspaceStore } from "./workspace.ts";
import { canUseIntegration, clearTurnPolicy, rememberApprovalRule, setTurnPolicy, toolsetAllowed, turnPolicy } from "./turn-policy.ts";
import { webMcpIntegration } from "./drivers/web-proxy.ts";
// multibot (F12): jednorazowy wybór modelu dla bieżącego zadania (natural
// language) — rozpoznawanie frazy + wycinanie jej z treści wiadomości.
import { detectOneShotModelRequest, stripModelRequest } from "./model-request.ts";
import { combineQueuedMessages, QueuedUserMessages } from "./queued-turns.ts";
import { ensureTlsMaterial } from "./tls-cert.ts";
import { currentReport, initNetAddress, isPrivateIPv4, noteReachedHost, pinAddress, refreshAddress, unmapPort } from "./net-address.ts";
import { rateLimitAddress, startTor, torBinary, torEnabled, type Tor } from "./tor.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const HOST = process.env.OMB_HOST?.trim() || "127.0.0.1";
const LOOPBACK_HOST = new Set(["127.0.0.1", "::1", "localhost"]).has(HOST.toLowerCase());
// TLS jest ZAWSZE, poza jednym świadomym wyjątkiem: reverse proxy, które samo
// kończy HTTPS i rozmawia z harnessem po loopbacku (docs/REMOTE-ACCESS.md).
const TLS_OFF = /^(0|off|false|no)$/i.test(process.env.OMB_TLS?.trim() ?? "");
const SCHEME = TLS_OFF ? "http" : "https";
const PUBLIC_URL = process.env.OMB_PUBLIC_URL?.trim().replace(/\/+$/, "");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = !LOOPBACK_HOST;

/** What to print as "the address". A server bound to one interface is only
 * reachable there, so advertising some other NIC would be a lie; only a
 * wildcard bind gets to pick. `OMB_PUBLIC_URL` still wins — someone who put a
 * real domain in front knows better than any discovery. */
function primaryAddress(port: number): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const loopback = `${SCHEME}://127.0.0.1:${port}`;
  const report = currentReport(port);
  if (HOST === "0.0.0.0" || HOST === "::") return report.current ?? loopback;
  // The bind check exists so we never advertise a NIC we are not listening on.
  // A relay is the one exception, and only because it is not another NIC: `ssh
  // -R` dials 127.0.0.1 from this very machine, so it reaches a loopback-only
  // server too. Everything else defers to `report.current`, so this and
  // `/api/server/address` can never disagree about which address we publish.
  // The onion joins the relay in that exemption for the same reason: it is not
  // another NIC either. Tor lands on 127.0.0.1:8798 from this very machine, so
  // a loopback-only bind answers on it too.
  if (report.candidates.some((candidate) => (candidate.kind === "relay" || candidate.kind === "onion") && candidate.address === report.current)) {
    return report.current as string;
  }
  const bound = new Set([`${SCHEME}://${HOST}:${port}`, `${SCHEME}://[${HOST}]:${port}`]);
  return report.candidates.find((candidate) => bound.has(candidate.address))?.address ?? loopback;
}

/** `scripts/relay-connect.sh` writes `DATA_DIR/relay.env` when the owner puts a
 * relay box of their own in front (docs/REMOTE-ACCESS.md). Read on every scan,
 * never cached: the script may land the file while the server is already up.
 * Only the value is taken — this is not a shell, so nothing here is executed. */
function relayHost(): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(DATA_DIR, "relay.env"), "utf8");
  } catch {
    return null; // no relay configured, or the file is unreadable
  }
  // Anchored at BOTH ends: a line with a character we do not accept is rejected
  // outright rather than silently truncated to the prefix that happened to fit.
  const host = /^RELAY_HOST=["']?([A-Za-z0-9.:[\]-]+)["']?[ 	]*$/m.exec(raw)?.[1];
  // A relay that resolves back to this machine is not a relay; it would publish
  // an address only this device can reach and call it public.
  if (!host || /^(localhost|::1|\[::1\])$/i.test(host) || isPrivateIPv4(host)) return null;
  return host;
}

// multibot (G2): a remote server owns one origin. Dev keeps Vite separate;
// remote mode serves the built app automatically unless explicitly overridden.
// With a relay in front, a loopback bind is still serving the whole internet —
// without this the tunnel would publish an API with no UI behind it.
// An onion is a public address like any other, so a server that is about to
// publish one is serving the whole internet even on a loopback bind.
const TOR_POSSIBLE = torEnabled() && torBinary() !== null;
const STATIC_DIR = process.env.OMB_STATIC_DIR || (REMOTE || relayHost() || TOR_POSSIBLE ? join(ROOT, "dist") : null);
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

// multibot (G5): browser must revalidate install metadata and worker code;
// Vite's fingerprinted assets are safe to retain for the app-shell cache.
function staticHeaders(file: string): Record<string, string> {
  const name = file.toLowerCase().replace(/\\/g, "/");
  const installMetadata = name.endsWith("/index.html") || name.endsWith(".webmanifest") || /\/(?:sw|service-worker)\.js$/.test(name);
  return {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": installMetadata
      ? "no-cache"
      : name.includes("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    "x-content-type-options": "nosniff",
    ...(/\/(?:sw|service-worker)\.js$/.test(name) ? { "service-worker-allowed": "/" } : {}),
  };
}

ensureDirs();
// Materiał TLS PO `ensureDirs` (migracja starego katalogu danych sprawdza, czy
// DATA_DIR jeszcze nie istnieje) i PRZED serwerem, bo `createServer` chce go
// od razu. `tls.crt` jest publiczny, `tls.key` ma 0600.
// `OMB_TLS=off` ma jedno zastosowanie: reverse proxy kończące TLS u siebie i
// rozmawiające z harnessem po pętli zwrotnej. Na adresie widocznym w sieci
// znaczyłoby to hasła i sesje gołym tekstem — dlatego nie ostrzeżenie, tylko
// odmowa startu: serwer, który cicho poszedł bez TLS-a, jest gorszy niż żaden.
if (TLS_OFF && !LOOPBACK_HOST) {
  console.error(`[multibot] OMB_TLS=off wolno użyć TYLKO na pętli zwrotnej, a OMB_HOST=${HOST}. Ustaw OMB_HOST=127.0.0.1 (za reverse proxy) albo zdejmij OMB_TLS.`);
  process.exit(1);
}
const TLS = TLS_OFF ? null : ensureTlsMaterial(DATA_DIR);
const TLS_FINGERPRINT = TLS?.fingerprint256 ?? null;
startOpenCodeModelRefresh();
const cfg = loadConfig();
const identity = new IdentityStore();
identity.init();
// Address discovery keeps its findings in the identity `meta` row and tells
// everyone when the answer changes: a live client refreshes its badge, the
// owner's phone gets one push so a new address never goes unnoticed.
/** Filled in once the server object exists (the onion ingress needs it). Every
 * reader goes through a function, so "not started yet" is simply null. */
let tor: Tor | null = null;
initNetAddress({
  scheme: SCHEME,
  mapPorts: !LOOPBACK_HOST,
  relayHost,
  onionHost: () => tor?.onionHost() ?? null,
  socksPort: () => tor?.socksPort() ?? null,
  tlsFingerprint: TLS_FINGERPRINT,
  getMeta: (key) => identity.getMeta(key),
  setMeta: (key, value) => identity.putMeta(key, value),
  onChange: (report) => {
    broadcast({ kind: "server.address", address: report.current, verified: report.verified });
    // The three values on a fresh install are read out of setup.json, and the
    // address in it was true for the second it was written. Keep that one field
    // honest; nothing else in the file ever changes.
    if (report.current) identity.updateSetupAddress(report.current);
    const owner = identity.members().find((member) => member.role === "owner");
    if (owner && report.current) {
      void notifyPushDevices("MultiBot server", `Server address is now ${report.current}`, undefined, { kind: "notify" }, [owner.userId]).catch(() => {});
    }
  },
});
// 0.4.0 dropped the installation-wide bearer token. The file keeps it (nothing
// rewrites config.json), but every client holding one is about to get a single
// 401 — say so loudly once, or the first restart looks like a crash.
try {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8")) as { auth?: { token?: string } };
  if (raw.auth?.token && identity.noteOnce("legacyTokenWarnedAt")) {
    console.warn("[multibot] config.json still holds the old auth.token — that rail is gone in 0.4.0.");
    console.warn("[multibot] old clients will be asked to sign in again (one 401, then the sign-in screen). The file is left untouched.");
  }
} catch {
  /* no config yet, or unreadable — nothing to warn about */
}
const identityAttempts = new Map<string, { startedAt: number; count: number }>();
// Ustawiane przy montażu bramki (na końcu pliku); unieważnienie sesji musi
// zerwać jej SSE/WS, inaczej wylogowany socket dalej dostaje zdarzenia.
let revokeAuthSessions = (_except?: import("node:stream").Duplex) => {};
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));
const groupStore = new GroupStore();
// Collaboration rooms stay durable so their read-only transcripts remain
// available from old chat chips after completion and server restarts.
const rooms = new RoomStore();
// Durable /goal sessions; pruned to the latest 20 settled per bot.
const goals = new GoalStore();
setInterval(() => goals.prune(), 5 * 60_000).unref?.();

const bus = new EventBus();
bus.attach(registry.instances());

// multibot (U22): serwer wysyła gotowe teksty kart (tytuły pytań/zgód), a
// przełącznik języka żyje po stronie klienta. Przeglądarkowy Accept-Language
// go nie odzwierciedla, więc klient podaje język przez ?lang= na SSE/API, a my
// trzymamy go tu jako zmienną modułową (MultiBot to jeden właściciel).
let uiLang: "pl" | "en" = "en";
const t = (pl: string, en: string): string => (uiLang === "pl" ? pl : en);

// ── peer-agent comms wiring ────────────────────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy calls; regenerated each boot (the proxy gets it via env).
const COMMS_TOKEN = randomBytes(24).toString("hex");
// A bot→bot message is a REAL turn on the recipient's own thread, with the
// full toolset (peer tools included), so B can answer, ask back, or pull in C.
// A conversation has NO message limit by design: it ends when both bots have
// what they need and stop writing ([NO REPLY] / [TASK COMPLETE]). What is left
// here is loop protection only — a duplicate guard, an acknowledgement brake,
// a wall clock, and a message count set so high that reaching it means a
// runaway, never a long piece of real work. It is not a "budget" the user is
// meant to see, and nothing in the UI counts against it.
const DEFAULT_COLLAB_MAX_MESSAGES = 200;
function collabMaxMessages(): number {
  const raw = Number(process.env.OMB_COLLAB_MAX_MESSAGES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_COLLAB_MAX_MESSAGES;
}
const DEFAULT_COLLAB_MAX_MS = 2 * 60 * 60_000;
function collabMaxMs(): number {
  const raw = Number(process.env.OMB_COLLAB_MAX_MS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_COLLAB_MAX_MS;
}
/** "Room only for task": a user @mention opens a collaboration room only when
 * the message also carries task language; bare mentions stay one-shot folds. */
const TASK_HINTS =
  /(razem|zadanie|zadania|współprac|wspolprac|collab|collaborat|\btogether\b|\btask\b|delegat|napisz do|napiszesz do|napisać do|napisac do|zrób|zrob|zróbcie|zrobcie|wykonaj|przygotuj|przygotować|przygotowac|opracuj|pomóż|pomoz|pomoc|pracujcie|wspólnie|wspolnie|pogadaj|pogadajcie|porozmawiaj|porozmawiajcie|przeprowadź|przeprowadz|przeprowadzcie|rozmow|dyskusj|konwersac|\btur\b|\bturach\b|\bturę\b|\bture\b|chat\b|pokój|pokoju|pokoi\b)/i;
// multibot (F9): głębokość tury, która TERAZ trwa u danego bota — druga (i
// wiarygodniejsza) połowa `chainDepth` w `store.ts`. Upstream ufa `depth` z env
// proxy, co działa, dopóki proxy startuje raz na turę (claude/ACP); bot silnika
const activeCommsDepth = new Map<string, number>();
// multibot: boty, których tura trzyma slot z OMB_MAX_PARALLEL_TURNS. Slot
// bierze tylko tura główna (nieizolowana, depth 0) — tura zagnieżdżona czekałaby
// na slot trzymany przez własnego wołającego.
const gatedTurnBots = new Set<string>();
/** Koniec tury (udany, błędny, przerwany, ubity watchdogiem) oddaje slot. */
function releaseTurnSlot(botId: string): void {
  if (!gatedTurnBots.delete(botId)) return;
  broadcast({ kind: "computer-queue", ...computerControl.releaseAgent(botId) });
}
// multibot (U1): prywatny Store nie zna izolowanych wątków grupy, ale ich
// zużycie nadal należy do konkretnego bota.
const isolatedTurnBots = new Map<string, string>();
// watchdog: busy stuck >70s -> auto clear (provider zawiesił się, brak turn.completed)
const busyWatchdog = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Zbrojenie (i przezbrajanie) watchdoga: brak `turn.completed` przez 70 s
 * znaczy zawieszonego dostawcę, więc bot wraca do wolnych. Wołane przy starcie
 * tury ORAZ po przyjętym steeringu — tura, do której właśnie dopisano zadanie,
 * z definicji trwa dłużej i nie może zostać zwolniona za plecami użytkownika.
 */
/** 70 s of a provider saying nothing means the provider is gone. Overridable
 * only so tests can reach the teardown without waiting out the real ceiling. */
function busyWatchdogMs(): number {
  const raw = Number(process.env.OMB_BUSY_WATCHDOG_MS);
  return Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : 70_000;
}

function armBusyWatchdog(botId: string): void {
  const pending = busyWatchdog.get(botId);
  if (pending) clearTimeout(pending);
  const wd = setTimeout(() => {
    const b = store.bot(botId);
    if (b?.busy) {
      console.warn(`[multibot] watchdog: ${botId} busy ${busyWatchdogMs()}ms no completed, force clear`);
      store.patchBot(botId, { busy: false });
      activeCommsDepth.delete(botId);
      busyWatchdog.delete(botId);
      // Ta sama rozbiórka co przy `runtime.error`: bez niej znacznik peer
      // przeżywał turę i NASTĘPNA, niezwiązana tura odsyłała swój tekst
      // wczorajszemu nadawcy, a kolejka stała bez drenażu.
      peerTurn.delete(botId);
      groupTurn.get(botId)?.done(""); // wiszący dostawca nie trzyma czatu grupy
      turnAssistantText.delete(b.threadId);
      turnUsedTool.delete(b.threadId);
      turnUserText.delete(b.threadId);
      releaseTurnSlot(botId); // zawieszony dostawca nie trzyma slotu całej floty
      broadcast({ kind: "bot", bot: store.bot(botId) });
      drainQueuedUserMessages(botId);
    }
  }, busyWatchdogMs());
  wd.unref?.();
  busyWatchdog.set(botId, wd);
}
// proxy entry: .ts in dev (node type-strips), .js in the packaged dist-server
const proxyPath = (...parts: string[]) => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), ...parts);
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
};
const agentsProxyPath = proxyPath("drivers", "agents-proxy.ts");
const computerProxyPath = proxyPath("computer", "mcp.ts");
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function proxyIntegration(proxy: string, botId: string) {
  return {
    command: process.execPath,
    args: [proxy],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_HARNESS_URL: `${SCHEME}://127.0.0.1:${PORT}`,
      OMB_BOT_ID: botId,
      OMB_COMMS_TOKEN: COMMS_TOKEN,
    },
  };
}

const agentsIntegration = (botId: string) => proxyIntegration(agentsProxyPath, botId);
/** The computer MCP server — same spawn shape as agents, a different entry file. */
const localComputerIntegration = (botId: string) => proxyIntegration(computerProxyPath, botId);

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a turn ceiling — by default
 * the old 4 minutes, overridable per caller via `timeoutMs`). */
/** Isolated thread for a one-shot delegated peer turn ("[Delegation from @X]",
 * no room view): the envelope and everything the peer does in that turn stay
 * off the peer's main chat. Stable per caller→peer pair, so the peer keeps
 * one session for delegated work. */
function delegationThreadId(callerBotId: string, peerBotId: string): string {
  return `delegation-${callerBotId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}-${peerBotId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}`;
}

function askBotAndWait(
  targetBotId: string,
  message: string,
  depth: number,
  options?: { threadId?: string; transcript?: Array<{ role: "user" | "assistant"; text: string }>; timeoutMs?: number; onText?: (text: string) => void; reasoning?: any },
): Promise<string> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve("(no such bot)");
  const threadId = options?.threadId ?? target.threadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    // multibot: strumień do wołającego — pokój pokazuje tekst w trakcie tury,
    // nie po 20 minutach, kiedy wygląda to na zacięcie. Delty buforujemy i
    // spłukujemy co sekundę, żeby nie robić wiadomości z pojedynczych tokenów;
    // item.completed zostaje wyłącznie źródłem zwracanej odpowiedzi.
    let deltaBuf = "";
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDelta = () => {
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = null;
      const chunk = deltaBuf;
      deltaBuf = "";
      // surowy tekst, bez trim — spłuk potrafi wypaść w środku wyrazu, a
      // odbiorca dokleja go do jednej rosnącej wiadomości
      if (chunk.trim()) options?.onText?.(chunk);
    };
    const finish = (out: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      flushDelta();
      unsub();
      resolve(out);
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      if (e.threadId !== threadId) return;
      if (options?.onText && e.type === "content.delta" && e.streamKind === "assistant_text") {
        deltaBuf += e.delta;
        if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 100);
      }
      if (e.type === "item.completed" && e.itemType === "assistant_text") {
        text += (text ? "\n" : "") + e.text;
      } else if (e.type === "turn.completed") {
        finish(text || "(the bot finished without a text reply)");
      }
    });
    // multibot: sufit tury jest parametrem, bo wołający mają różną tolerancję —
    // grupy trzymają odpowiedź HTTP przez czas wszystkich botów sekwencyjnie,
    // więc dziedziczenie długiego sufitu po cichu wieszałoby czat.
    const timer = setTimeout(
      () => {
        // timeout -> anuluj provider turn i zwolnij busy
        const instId = store.bot(targetBotId)?.modelSelection.instanceId;
        if (instId) void registry.get(instId)?.adapter.interruptTurn(threadId as any).catch(() => {});
        // force clear busy jesli provider nie wyslal turn.completed
        const b = store.bot(targetBotId);
        if (b?.busy) {
          store.patchBot(targetBotId, { busy: false });
          if (busyWatchdog.has(targetBotId)) { clearTimeout(busyWatchdog.get(targetBotId)!); busyWatchdog.delete(targetBotId); }
          activeCommsDepth.delete(targetBotId);
          broadcast({ kind: "bot", bot: store.bot(targetBotId) });
        }
        finish(text || "(timed out waiting for the bot to reply)");
      },
      options?.timeoutMs ?? 60_000,
    );
    startTurn(targetBotId, message, { commsDepth: depth + 1, ...options, origin: "bot" }).catch((err) =>
      finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`),
    );
  });
}

/** Delegated peer turn ("[Delegation from @X]", no room view) on an ISOLATED
 * thread: the envelope and everything the peer does stay off its main chat —
 * only the returned text reaches the caller, exactly like before. */
async function delegatedPeerTurn(callerId: string, peerId: string, message: string, depth: number): Promise<string> {
  const peer = store.bot(peerId);
  if (!peer) return "(no such bot)";
  // busy refusal keeps the old reply semantics: a non-isolated turn used to
  // die on startTurn's busy guard and fold this exact note back to the caller
  if (peer.busy) return "(couldn't start that bot: the bot is already working — interrupt it first)";
  // multibot (F9): izolowana nitka omija gałąź !isolated w startTurn, która
  // normalnie stawia znacznik głębokości — bez niego bot silnika (deklarujący
  // 0 na zawsze) mógłby po delegacji wywołać kolejnego bota i wydłużyć łańcuch.
  activeCommsDepth.set(peerId, depth + 1);
  try {
    return await askBotAndWait(peerId, `[Delegation from @${store.bot(callerId)?.name ?? callerId}] ${message}`, depth, {
      threadId: delegationThreadId(callerId, peerId),
      timeoutMs: 60_000,
    });
  } finally {
    // sprzątamy tylko własny wpis — równoległa tura mogła postawić głębszy
    if ((activeCommsDepth.get(peerId) ?? 0) <= depth + 1) activeCommsDepth.delete(peerId);
    // Izolowana tura nie wysyła `turn.completed` na główny wątek, więc nic tu
    // nie opróżnia kolejki — a peer message przyjęta w tym oknie parkowała w
    // niej na zawsze (drain wychodzi na `activeCommsDepth`, które stawiamy
    // wyżej właśnie dla tej tury).
    drainQueuedUserMessages(peerId);
  }
}

// multibot: cel (runGoal) czeka 60s (24*2.5s) na zajętego bota — najzwyklejszy
// przypadek to użytkownik, który dopisał zwykłą wiadomość w trakcie celu, i nie
// chcemy trzymać pętli na martwym bocie.
const IDLE_WAIT_MS = 2_000;
const IDLE_ROUNDS_LIMIT = 30;

/** What a CLIENT may see of a thread. Peer envelopes and the answers a bot
 * writes to a colleague live on the thread for the transcript replay only;
 * the chat shows a room chip instead. */
const chatMessages = (threadId: string) => store.messagesFor(threadId).filter((m) => !m.hidden);

/**
 * Clickable "X texted Y" / "Y replied" pill on a bot's own thread, pointing at
 * the room. This pill is ALL the user sees of a bot↔bot exchange in a private
 * chat: the envelopes and the answers themselves live in the room transcript,
 * which the pill opens. Without `chip` it names the whole room (group turns,
 * legacy call sites).
 */
function postRoomChip(
  threadBotId: string,
  room: RoomRecord,
  chip?: { from: string; to?: string; event: "texted" | "replied" },
) {
  const owner = store.bot(threadBotId);
  if (!owner) return;
  const message = store.appendMessage(owner.threadId, {
    role: "bot",
    kind: "room",
    room: {
      id: room.id,
      name: room.name,
      bot_ids: chip ? [chip.from, ...(chip.to ? [chip.to] : [])] : [...room.bot_ids],
      ownerBotId: chip?.from ?? threadBotId,
      status: room.status,
      ...(chip ? { event: chip.event } : {}),
      ...(room.groupId ? { groupId: room.groupId } : {}),
    },
  });
  broadcast({ kind: "message", threadId: owner.threadId, message });
}

/** Strip @mentions of the tagged bots out of the task text. */
function stripMentions(text: string, tagged: Array<{ name: string }>): string {
  let out = text;
  for (const t of tagged) {
    const escaped = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`@${escaped}`, "gi"), "");
  }
  return out.trim() || text;
}

/** Settled room, rendered as text a bot can read in its own chat turn. */
function roomSummary(roomId: string): string {
  const final = rooms.get(roomId);
  return final && final.transcript.length
    ? final.transcript.map((m) => `${store.bot(m.from)?.name ?? m.from}: ${m.text}`).join("\n\n")
    : "(the collaboration produced no result)";
}

/** Tell the bot that opened a room how it ended. */
function reportRoom(roomId: string, status: string, reason = ""): void {
  const room = rooms.get(roomId);
  const owner = room && store.bot(room.ownerBotId);
  if (!room || !owner) return;
  const report = store.appendMessage(owner.threadId, {
    role: "bot",
    kind: "text",
    text: `Room "${room.name}" finished (${status})${reason ? ` — ${reason}` : ""}.\n\n${roomSummary(roomId)}`,
  });
  broadcast({ kind: "message", threadId: owner.threadId, message: report });
}

/** Settle a room and report it back to the bot that opened it. Every way a
 * conversation can end — [TASK COMPLETE], spent budget, spent clock — comes
 * through here, so the owner always learns how it went exactly once. */
function closeRoom(roomId: string, status: "done" | "failed", reason = ""): void {
  const room = rooms.get(roomId);
  if (!room || room.status !== "running") return;
  rooms.setStatus(roomId, status);
  for (const key of [...sentPeerText.keys()]) if (key.startsWith(`${roomId}|`)) sentPeerText.delete(key);
  ackStreak.delete(roomId);
  rooms.setPending(roomId, null); // a closed room owes nobody a turn after a restart
  const settled = rooms.get(roomId);
  if (settled) broadcast({ kind: "room", room: settled });
  if (!room.groupId) reportRoom(roomId, status, reason);
}

/** The wall clock only ever fired when somebody tried to send. A conversation
 * that simply went quiet stayed "running" forever: an open room in the UI, a
 * live budget, and no report to its owner. */
function sweepExpiredRooms(): void {
  const cutoff = Date.now() - collabMaxMs();
  for (const room of rooms.list()) {
    // A group room is the user's chat, not a task: it does not expire, and it
    // is nobody's "collaboration result" to report into a private thread.
    if (room.status !== "running" || room.groupId || room.createdAt > cutoff) continue;
    startBudgetCooldown(room.id);
    closeRoom(room.id, "done", "");
  }
}

/**
 * Boot: a room that was mid-conversation when the process died. The transcript
 * survived, so the only thing missing is the turn that was about to start —
 * `pendingTo` names who owed it. Re-deliver that last message and the
 * conversation carries on; write the room off only when its budget or its
 * clock is genuinely spent (or nobody owed anything).
 */
function resumeRecoveredRooms(): void {
  const max = collabMaxMessages();
  for (const roomId of rooms.recovered) {
    const room = rooms.get(roomId);
    if (!room || room.status !== "running") continue;
    // A group room is the user's own chat: it has no pending peer turn to
    // resume and it is nobody's collaboration result to report.
    if (room.groupId) continue;
    const last = room.transcript.at(-1);
    const stale = Date.now() - (last?.at ?? room.createdAt) >= collabMaxMs();
    if (!room.pendingTo || !last || stale || budgetLeft(room, max) <= 0) {
      closeRoom(roomId, "failed", "the server restarted mid-conversation");
      continue;
    }
    const to = room.pendingTo;
    void deliverPeerMessage(last.from, to, last.text, roomId)
      .then((delivery) => {
        // A recipient that is gone (deleted bot, revoked permission) can never
        // take that turn: settle the room instead of leaving it open forever.
        if (delivery.status === "refused") closeRoom(roomId, "failed", "the server restarted mid-conversation");
      })
      .catch((error) =>
        console.warn(`[multibot] resuming room ${roomId} failed:`, error instanceof Error ? error.message : error),
      );
  }
}

/** User @mentions another bot with a task → open a collaboration room. Returns
 * the room plus the cleaned task text, or null when there is nothing to
 * collaborate on (no tags, or a quick question).
 *
 * Nie doręcza pierwszej wiadomości i nie wiesza pigułki — rozmowa jest ciągiem
 * tur i wolno jej trwać godzinami, więc czekanie na nią w obsłudze
 * `POST /messages` trzymałoby odpowiedź HTTP tak długo, że czat wyglądałby na
 * zawieszony. Doręczenie należy do wywołującego, w tle. */
function maybeStartCollab(botId: string, text: string): { room: RoomRecord; task: string } | null {
  const bot = store.bot(botId);
  if (!bot) return null;
  const peers = store.bots.filter((b) => b.id !== botId && !b.hidden && canBotContact(bot, b));
  const tagged = mentionedBots(text, peers);
  if (!tagged.length) return null;
  // "Room only for task": a bare @mention ("hey @B", "ask @B once") keeps the
  // existing one-shot fold; task language opens a collaboration room.
  if (!TASK_HINTS.test(text)) return null;
  if (!canUseIntegration(bot.threadId, "delegation") || workspace.permissions(botId).delegation === false) {
    return null;
  }
  const task = stripMentions(text, tagged);
  const room = rooms.create({
    task,
    bot_ids: [botId, ...tagged.map((t) => t.id)],
    ownerThread: bot.threadId,
    ownerBotId: botId,
  });
  return { room, task };
}

// Default selection for new bots: a real CLI provider first. The embedded
// engine is hidden from the model picker, so a bot parked on it cannot be moved
// off it from the UI — see `defaultSelectionTarget`.
async function defaultSelection(described?: Awaited<ReturnType<ProviderRegistry["describe"]>>) {
  const fleet = described ?? (await registry.describe());
  const enabled = fleet.filter((d) => d.enabled !== false);
  const pick = defaultSelectionTarget(enabled) ?? defaultSelectionTarget(fleet);
  return { instanceId: pick?.instanceId ?? "claude", model: pick?.models.default || "claude-sonnet-5" };
}
let bootSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const store = new Store(() => bootSelection);
const workspace = new WorkspaceStore();
const attachments = new AttachmentStore();
// multibot: bot→user file sending. Files the bot creates via the agents MCP
// `send_file` tool land here, keyed by thread, and ride the bot's next chat
// message (see the item.completed / assistant_text handler below).
const pendingBotAttachments = new Map<string, ReturnType<AttachmentStore["add"]>[]>();
// multibot 0.1.44: wiadomości wysłane w trakcie tury bota. Zamiast 409 każda
// ląduje w wątku i w kolejce; koniec tury odpala drain — bot dostaje je wszystkie
// naraz i odpowiada JEDNĄ odpowiedzią na wszystko.
const queuedUserMessages = new QueuedUserMessages();
// Rooms are the ONE ledger of every bot-to-bot exchange; there is no second
// mailbox any more. read_bot_mail reads what landed in a bot's rooms since it
// last looked. The cursor lives in this process, so a restart replays a room's
// tail once instead of losing it. An old data/bot-mail.json is simply ignored.
const roomReadAt = new Map<string, number>();

/** Messages other bots wrote in this bot's rooms since its last read. */
function unreadRoomMessages(botId: string): Array<{ room: RoomRecord; from: string; text: string; at: number }> {
  const since = roomReadAt.get(botId) ?? 0;
  roomReadAt.set(botId, Date.now());
  return rooms
    .list()
    .filter((room) => room.bot_ids.includes(botId))
    .flatMap((room) =>
      room.transcript
        .filter((message) => message.from !== botId && message.at > since)
        .map((message) => ({ room, from: message.from, text: message.text, at: message.at })),
    )
    .sort((a, b) => a.at - b.at);
}

// ── bot↔bot: a message is a turn ───────────────────────────────────────
// One primitive carries every bot→bot exchange (ask_bot, send_bot_mail,
// start_collab, group messages, a user's @mention, and the automatic reply a
// finished turn sends back). It appends to the room ledger, then hands the
// text to the recipient's MAIN thread through deliverToActiveTurnOrQueue —
// steered into a live turn where the driver supports it, queued otherwise.
// A busy peer is never a refusal.

/** Peer messages a bot is currently answering, oldest first. It is a LIST, not
 * one entry: two bots can write to the same recipient inside one turn, and
 * keying by recipient alone dropped the first sender on the floor. `replied`
 * flips when the bot answers THAT sender itself, so the turn.completed safety
 * net does not send a second copy. */
interface PeerAnswer {
  fromBotId: string;
  roomId: string;
  replied: boolean;
  /** Queued behind a turn that was already running. The turn that finishes
   * next has not read this message yet, so its text is not an answer to it —
   * the entry waits for the turn the drain starts. */
  deferred: boolean;
}
const peerTurn = new Map<string, PeerAnswer[]>();
/** Turn a member is running FOR a group chat, keyed by that member's bot id.
 * Separate from `peerTurn` because the sender is the user, not a colleague:
 * nothing routes back automatically, the group loop only needs to know the
 * turn ended (and with what text) before it hands the transcript to the next
 * member — that is what lets a later member see an earlier one's answer. */
interface GroupAnswer {
  group: { id: string; name: string };
  roomId: string;
  members: Array<{ name: string; description?: string }>;
  /** The envelope queued behind a turn that was already running. The turn that
   * finishes next was not answering us, so its text is not the group answer —
   * exactly the `PeerAnswer.deferred` rule, for the same reason. */
  deferred: boolean;
  done: (text: string) => void;
}
const groupTurn = new Map<string, GroupAnswer>();
/** Last text each sender→recipient pair carried inside a room. Repeating it
 * verbatim is a loop, not a contribution. Keyed per pair so a fan-out to a
 * group (same text, several recipients) is not mistaken for one. */
const sentPeerText = new Map<string, string>();
/** Pairs whose conversation was just cut off by a budget. Without this a spent
 * budget is a formality: both bots simply open a NEW room with a fresh 24 and
 * carry on. Keyed by the unordered pair, cleared by time alone. */
const budgetCooldown = new Map<string, number>();
const DEFAULT_COLLAB_COOLDOWN_MS = 10 * 60_000;
function collabCooldownMs(): number {
  const raw = Number(process.env.OMB_COLLAB_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_COLLAB_COOLDOWN_MS;
}
const pairKey = (a: string, b: string) => [a, b].sort().join("|");
/** Milliseconds left before this pair may open a new room; 0 = go ahead. */
function budgetCooldownLeft(a: string, b: string): number {
  const until = budgetCooldown.get(pairKey(a, b));
  if (until === undefined) return 0;
  const left = until - Date.now();
  if (left > 0) return left;
  budgetCooldown.delete(pairKey(a, b));
  return 0;
}
/** Every pair in a room that ran out of budget waits before starting over. */
function startBudgetCooldown(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room || collabCooldownMs() <= 0) return;
  const until = Date.now() + collabCooldownMs();
  for (const a of room.bot_ids) for (const b of room.bot_ids) if (a < b) budgetCooldown.set(pairKey(a, b), until);
}

/** Assistant text a thread produced during the turn that is running now, so
 * the peer safety net forwards THIS turn's answer and never an older one.
 * Filled on item.completed, drained by turn.completed, dropped on failure. */
const turnAssistantText = new Map<string, string[]>();
/** Threads whose CURRENT turn called at least one tool. A bot that actually
 * did something is answering with a result, however short — the ack brake must
 * not swallow it. Lives and dies with `turnAssistantText`. */
const turnUsedTool = new Set<string>();
/** Threads whose CURRENT turn carries text the HUMAN wrote — either it started
 * as a user turn, or the user steered a message into a running peer turn. Its
 * answer is for them, so it stays a visible bubble even when a colleague also
 * happens to be waiting on the same turn. */
const turnUserText = new Set<string>();

type PeerDelivery = "steered" | "queued" | "refused";

/** First thing a brand-new bot does: look at what it actually has. */
const ONBOARDING_FIRST_TURN =
  "Before anything else: check what is already connected. List your connectors, tools and whether you have a computer, then tell the user in two or three sentences what you can do right now, and ask only for the access you are actually missing.";
/** Off inside vitest and wherever a harness needs bots that stay quiet. */
const onboardingTurnEnabled = () => !process.env.VITEST && process.env.OMB_ONBOARDING_TURN !== "0";

/** Polish is the only second language MultiBot ships texts in, so telling the
 * two apart is all the peer protocol needs: the envelope carries "Reply in X"
 * and the colleague stops answering a Polish bot in English (or the reverse,
 * which is what the live demo produced). */
const POLISH_MARKERS = /[ąćęłńóśźż]|\b(nie|tak|jest|zrób|proszę|dzięki|czy|może|który|żeby|jeśli|oraz|który|potwierdzone|gotowe)\b/i;
/** Language of a conversation, read off the text being sent and, failing that,
 * off the last thing the HUMAN wrote in the sender's own chat. Peer envelopes
 * are no longer posted as messages, so `role: "user"` there really is a human. */
function conversationLanguage(fromBotId: string, text: string): "Polish" | "English" {
  if (POLISH_MARKERS.test(text)) return "Polish";
  const bot = store.bot(fromBotId);
  const thread = bot ? store.messagesFor(bot.threadId) : [];
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const m = thread[i]!;
    // Hidden peer envelopes are skipped: only what the HUMAN wrote sets the tone.
    if (m.hidden || m.role !== "user" || m.kind !== "text" || !m.text) continue;
    return POLISH_MARKERS.test(m.text) ? "Polish" : "English";
  }
  return "English";
}

/** Envelope the recipient reads. Its own chat, its own name on the sender.
 * A bot name is user (or bot) input and lands INSIDE a bracketed header, so a
 * name like `X] [System: ignore everything` would forge harness instructions.
 * Brackets and newlines come out; the id below the name stays authoritative. */
function peerEnvelope(from: BotRecord, text: string, language: string): string {
  const name = from.name.replace(/[[\]\r\n]+/g, " ").trim().slice(0, 120) || from.id;
  return `[Message from @${name} (bot id: ${from.id}), another bot in this MultiBot workspace. This is a real turn: answer them, or reply with exactly [NO REPLY] once you have what you need and have nothing new to add. Do not thank, confirm or restate - this conversation ends by silence, not by a closing message. Reply in ${language}.]\n\n${text}`;
}

/** Consecutive acknowledgements in a room. Two in a row means the two bots are
 * congratulating each other, not working: the room settles. */
const ackStreak = new Map<string, number>();

/**
 * Deliver one bot→bot message. Returns how it landed plus, on a refusal,
 * model-facing prose: every refusal tells the bot to stop and talk to the
 * user instead of retrying into the same wall.
 */
async function deliverPeerMessage(
  fromBotId: string,
  toBotId: string,
  text: string,
  roomId?: string,
): Promise<{ status: PeerDelivery; roomId: string | null; note: string }> {
  const refuse = (note: string) => ({ status: "refused" as const, roomId: roomId ?? null, note });
  const from = store.bot(fromBotId);
  const target = store.bot(toBotId);
  if (!from) return refuse("You are not a known bot here. Do not retry; tell the user.");
  if (!target || !canBotContact(from, target)) {
    return refuse("There is no such bot in your workspace. Do not retry; tell the user who you tried to reach.");
  }
  if (fromBotId === toBotId) return refuse("A bot cannot message itself. Do not retry; do the work or tell the user.");
  const message = text.trim();
  if (!message) return refuse("An empty message is not worth a turn. Do not retry; say something or say nothing.");
  if (message.length > 8_000) return refuse("That message is over 8000 characters. Do not retry; send the short version.");
  if (workspace.permissions(fromBotId).delegation === false) {
    return refuse("Bot-to-bot messaging is switched off for you. Do not retry; tell the user it is disabled in your permissions.");
  }
  // Read-only is checked HERE, not at the callers: /api/internal/ask-bot, the
  // group fan-out, the user's @mention and the automatic reply all land in
  // this one function, and only `mail.send` ever went past the action-level
  // gate above it.
  if (workspace.access(fromBotId).access === "read-only") {
    return refuse("You have read-only access, so you cannot message other bots. Do not retry; tell the user.");
  }
  if (from.chiefOfStaff && (target.section?.trim() ?? "") !== (from.section?.trim() ?? "")) {
    return refuse("As a chief of staff you may only message bots in your own section. Do not retry; tell the user.");
  }

  // Room ledger: an explicit room wins, then the conversation this bot is
  // already in (so A→B→C stays ONE room and ONE budget), then any open room
  // with this peer, and only then a new one. A GROUP room is never inherited:
  // a bot answering in a group that then writes to an outsider would drag that
  // outsider into the group's transcript.
  const inherited = (peerTurn.get(fromBotId) ?? [])
    .map((entry) => rooms.get(entry.roomId))
    .find((candidate) => candidate?.status === "running" && !candidate.groupId) ?? null;
  const existing = (roomId ? rooms.get(roomId) : null) ?? inherited ?? rooms.runningWith([fromBotId, toBotId]);
  if (!existing) {
    const cooling = budgetCooldownLeft(fromBotId, toBotId);
    if (cooling > 0) {
      return refuse(
        `Your last conversation with that bot ran out of budget ${Math.ceil(cooling / 60_000)} minute(s) ago. Do not open another one; report to the user instead.`,
      );
    }
  }
  const room =
    existing ??
    (() => {
      const opened = rooms.create({
        task: message.slice(0, 200),
        bot_ids: [fromBotId, toBotId],
        ownerThread: from.threadId,
        ownerBotId: fromBotId,
      });
      return opened;
    })();
  if (room.status !== "running") {
    return refuse("That conversation is already closed. Do not retry; report what you have to the user.");
  }
  rooms.addBot(room.id, fromBotId);
  rooms.addBot(room.id, toBotId);

  const max = collabMaxMessages();
  if (budgetLeft(room, max) <= 0) {
    startBudgetCooldown(room.id);
    closeRoom(room.id, "done", "");
    return refuse("This conversation has run long enough - wrap up and report to the user. Do not retry.");
  }
  if (Date.now() - room.createdAt >= collabMaxMs()) {
    startBudgetCooldown(room.id);
    closeRoom(room.id, "done", "");
    return refuse("This conversation ran out of time - wrap up and report to the user. Do not retry.");
  }
  const ledgerKey = `${room.id}|${fromBotId}|${toBotId}`;
  if (sentPeerText.get(ledgerKey) === message) {
    return refuse("You already sent that bot exactly this message. Do not retry; wait for its answer or tell the user.");
  }
  sentPeerText.set(ledgerKey, message);

  /** Record this message in the room ledger and show it on the UI. The same
   * text fanned out to several bots is ONE line. */
  const recordInRoom = () => {
    if (!isDuplicateOfLast(room, fromBotId, message)) rooms.append(room.id, fromBotId, message);
    broadcast({ kind: "room", room: rooms.get(room.id) });
  };

  // Is this message an ANSWER to the bot we are writing to? Read from the room
  // ledger, not from the caller: `send_bot_mail`, `ask_bot`, `collab.start`,
  // the group fan-out, the boot resume and the automatic reply all land here,
  // and only the last one used to declare itself a reply — so a bot that
  // answered its colleague through a TOOL skipped the ack brake entirely and
  // the two of them talked until the message count ran out. The ledger knows:
  // the recipient has spoken here since the last thing WE said, so whatever we
  // send now answers it. (Not "the recipient wrote the last line": in a room
  // with three bots somebody else's line lands in between.)
  const lastLineFrom = (who: string): number => {
    for (let i = room.transcript.length - 1; i >= 0; i -= 1) if (room.transcript[i]!.from === who) return i;
    return -1;
  };
  const isReply = lastLineFrom(toBotId) > lastLineFrom(fromBotId);

  // The ack brake. "Confirmed." / "Potwierdzone." bounced eleven times in a
  // live demo before the message count ran out: an answer that adds nothing is
  // worth a line in the transcript, never another turn. Two in a row and the
  // two bots are done talking, so the room settles by itself instead of idling
  // until the wall clock.
  //
  // No "the turn used a tool" carve-out: on a real fleet almost every turn
  // calls a tool, which switched the brake off for almost every message. It was
  // never needed — `done`/`gotowe`/`yes`/`no` are deliberately not
  // acknowledgement words (rooms.ts), so a short real RESULT already passes.
  if (isReply && isAcknowledgement(room, fromBotId, message)) {
    recordInRoom();
    postRoomChip(toBotId, room, { from: fromBotId, event: "replied" });
    for (const entry of peerTurn.get(fromBotId) ?? []) if (entry.fromBotId === toBotId) entry.replied = true;
    const streak = (ackStreak.get(room.id) ?? 0) + 1;
    ackStreak.set(room.id, streak);
    // Two content-free replies in a row and the two bots are congratulating
    // each other, not working. In a room with only TWO bots the second one can
    // never arrive: this reply was not delivered, so the other side gets no
    // turn and will never write again — its silence IS the second one, and the
    // conversation is over. Leaving the room open just parked it until the wall
    // clock swept it up hours later. A GROUP room is the user's own chat: two
    // polite members must never close the room the user is still writing into.
    if (!room.groupId && (streak >= 2 || room.bot_ids.length <= 2)) closeRoom(room.id, "done", "");
    return refuse("An acknowledgement is not a reply. It was recorded; do not send another one.");
  }
  ackStreak.delete(room.id);

  recordInRoom();
  // Answered only the bot we are actually writing TO: forwarding work to a
  // third bot is not an answer, and marking it as one left the original sender
  // waiting on a reply that never came.
  for (const entry of peerTurn.get(fromBotId) ?? []) if (entry.fromBotId === toBotId) entry.replied = true;

  // What the user sees of this exchange in a private chat: a chip, never the
  // envelope. "X texted Y" in the sender's own thread; the answer coming back
  // shows as "Y replied" in the thread of whoever asked. The words themselves
  // live in the room the chip opens.
  if (isReply) postRoomChip(toBotId, room, { from: fromBotId, event: "replied" });
  else postRoomChip(fromBotId, room, { from: fromBotId, to: toBotId, event: "texted" });

  // The envelope goes to the MODEL, never to the user's chat: a raw
  // "[Message from @X (bot id: …)]" bubble is the noise this design exists to
  // remove. It is still STORED on the thread, hidden, because the transcript
  // replay walks the thread — without it an API driver would start the next
  // turn with no memory of what the colleague asked. Not broadcast, so no
  // client ever renders it.
  const envelope = peerEnvelope(from, message, conversationLanguage(fromBotId, message));
  store.appendMessage(target.threadId, { role: "user", kind: "text", text: envelope, hidden: true });
  // A live turn is `activeCommsDepth`, not `busy`: accepting a message lights
  // `busy` on its own, and a turn that has not started yet still reads what is
  // waiting for it.
  const answer: PeerAnswer = { fromBotId, roomId: room.id, replied: false, deferred: activeCommsDepth.has(toBotId) };
  peerTurn.set(toBotId, [...(peerTurn.get(toBotId) ?? []), answer]);
  // Persisted BEFORE delivery: a crash between here and the recipient's turn
  // is exactly the case boot-time resume has to repair.
  rooms.setPending(room.id, toBotId);
  const status = await deliverToActiveTurnOrQueue(toBotId, envelope, "bot", { attachments: [], origin: "bot" });
  // Steering puts the text INSIDE the running turn, so that turn does answer
  // it — and its `startTurn` is long past, so clear the debt here or a restart
  // would deliver a message the bot has already read.
  if (status === "steered") {
    answer.deferred = false;
    rooms.setPending(room.id, null);
  }
  return { status, roomId: room.id, note: "" };
}

/** Both markers count only as the CLOSING line of a reply. Matched anywhere,
 * a bot quoting the protocol ("end with [TASK COMPLETE] when we are done")
 * would close the room mid-conversation. */
const DONE_MARKER_AT_END = new RegExp(`\\n?\\[${ROOM_DONE_MARKER.slice(1, -1)}\\]\\s*$`);
const NO_REPLY_MARKER = "[NO REPLY]";

/** A finished turn that was answering a peer routes its prose back — unless
 * the bot chose silence ([NO REPLY]) or declared the whole task done.
 * `mayDelegate` is the verdict of the turn that just ended: it is read in the
 * bus handler, because `clearTurnPolicy` runs right after this is scheduled. */
async function routePeerReply(
  botId: string,
  peer: PeerAnswer,
  text: string,
  mayDelegate: boolean,
): Promise<void> {
  const room = rooms.get(peer.roomId);
  const done = DONE_MARKER_AT_END.test(text);
  const visible = (done ? text.replace(DONE_MARKER_AT_END, "") : text).trim();
  if (done) {
    if (visible && room && !isDuplicateOfLast(room, botId, visible)) rooms.append(peer.roomId, botId, visible);
    // A group room is a standing chat, not a task: one member declaring the
    // work finished must not close the room the user is still writing into.
    if (room?.groupId) broadcast({ kind: "room", room: rooms.get(peer.roomId) });
    else closeRoom(peer.roomId, "done");
    return;
  }
  // Silence is how a bot↔bot conversation ENDS: the bot has what it needs and
  // has nothing new to add, so it says nothing. Leaving the room "running"
  // meant nobody ever wrote to it again and the wall-clock sweeper reported it
  // to the owner two hours later as "time budget spent" — the one correct
  // ending dressed up as a failure. A group room is the user's own chat and
  // never closes on a member's silence.
  if (!visible || visible === NO_REPLY_MARKER) {
    if (room && !room.groupId) closeRoom(peer.roomId, "done", "");
    return;
  }
  // A bot whose delegation was off for this turn does not get to answer a peer
  // through the back door of the safety net. Its answer stays in its own chat,
  // where the bubble is kept visible for exactly this case.
  if (!mayDelegate) return;
  const delivery = await deliverPeerMessage(botId, peer.fromBotId, visible, peer.roomId);
  // The bubble was suppressed on the assumption this text would reach the room.
  // A refusal breaks that assumption — read-only access, a chief-of-staff
  // section mismatch, a room the other side already closed, a spent budget or
  // clock — and the answer would exist nowhere at all. Put it back in the
  // bot's own chat, with the reason, rather than lose it. An acknowledgement
  // is the one refusal that IS recorded in the room, so it stays quiet.
  // ponytail: this leaves the same text on the thread twice (once hidden, once
  // visible) on a path that only fires when a delivery is refused; dedupe it if
  // refusals ever become common enough to bloat a transcript.
  if (delivery.status === "refused" && !delivery.note.startsWith("An acknowledgement")) {
    const author = store.bot(botId);
    if (author) {
      const kept = store.appendMessage(author.threadId, { role: "bot", kind: "text", text: visible });
      broadcast({ kind: "message", threadId: author.threadId, message: kept });
    }
  }
}

// ── group chat: one room, the user writes to everyone, members pick who answers ──
// A group is a normal chat that happens to have several bots in it. The user's
// message goes to the members ONE AT A TIME on their own main threads, each
// with the transcript so far, so a later member reads what an earlier one
// already said and can stay quiet ([NO REPLY]) or hand the task over (@Name).

/** Sender id used for the user's own lines in a group room ledger. */
const ROOM_USER_SENDER = "user";
/** How long one member may hold up the group before the next one is asked. */
const GROUP_MEMBER_TURN_MS = 4 * 60_000;

/** What a member reads: who is in the room, what was said, and that a human
 * is on the other end. Names are user input, so they land inside the header
 * with brackets and newlines stripped, exactly like `peerEnvelope`. */
function groupEnvelope(groupName: string, roster: BotRecord[], room: RoomRecord): string {
  const safe = (raw: string) => raw.replace(/[[\]\r\n]+/g, " ").trim().slice(0, 120);
  const nameOf = (from: string) => (from === ROOM_USER_SENDER ? "User" : safe(store.bot(from)?.name ?? from));
  const transcript = room.transcript.map((m) => m.text).join("\n");
  const header = `[Group chat "${safe(groupName)}" with ${roster.map((b) => `@${safe(b.name)}`).join(", ")}. `
    + "The user writes to the whole group. The conversation so far follows; answer it, hand it over with @Name, "
    + `or reply with exactly [NO REPLY] if someone else already covered it. Reply in ${conversationLanguage(roster[0]?.id ?? "", transcript)}.]`;
  return `${header}\n\n${room.transcript.map((m) => `${nameOf(m.from)}: ${m.text}`).join("\n\n")}`;
}

/** Run one member's group turn and resolve with the text it produced.
 * Deliberately QUEUES instead of steering a live turn: the answer this returns
 * is appended to the group room verbatim, so it has to come from a turn that
 * read the group envelope and ran with the group prompt block - not from a
 * private turn that happened to be running and had the envelope steered into
 * it. Returns "" when the bot is already answering another group. */
async function askGroupMember(target: BotRecord, answer: Omit<GroupAnswer, "done" | "deferred">, envelope: string): Promise<string> {
  // One group turn per bot at a time. Two groups sharing a member would share
  // the single slot, and the second would collect the first one's text.
  if (groupTurn.has(target.id)) return "";
  const bubble = store.appendMessage(target.threadId, { role: "user", kind: "text", text: envelope });
  broadcast({ kind: "message", threadId: target.threadId, message: bubble });
  return await new Promise<string>((resolve) => {
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      if (groupTurn.get(target.id)?.done === finish) groupTurn.delete(target.id);
      resolve(text);
    };
    // A turn already running has not read this envelope, so its completion is
    // not our answer: the first `turn.completed` only clears the flag.
    groupTurn.set(target.id, { ...answer, deferred: activeCommsDepth.has(target.id), done: finish });
    // ponytail: a dead turn must not stall the whole group; per-member ceiling,
    // per-group budget if that ever needs tuning.
    setTimeout(() => finish(""), GROUP_MEMBER_TURN_MS).unref?.();
    queueUserTurn(target.id, envelope, { attachments: [], origin: "bot" });
  });
}

/**
 * Deliver the user's group message to every member in a stable order and
 * collect what each of them said. Returns one entry per member that spoke.
 */
async function runGroupChat(
  group: { id: string; name: string },
  room: RoomRecord,
  roster: BotRecord[],
  targets: BotRecord[],
): Promise<Array<{ bot_id: string; reply: string }>> {
  // Roster, not targets: an @mention narrows who is ASKED, never who the group
  // contains - a member told only about the mentioned bots could not hand off.
  const members = roster.map((bot) => ({ name: bot.name, description: bot.description }));
  const spoke: Array<{ bot_id: string; reply: string }> = [];
  /** Members a colleague already handed the task to: peer delivery owns their
   * turn now, so the group loop must not ask them the same thing twice. */
  const handedOver = new Set<string>();
  const max = collabMaxMessages();
  for (const [index, target] of targets.entries()) {
    if (handedOver.has(target.id)) continue;
    const current = rooms.get(room.id);
    if (!current || current.status !== "running" || budgetLeft(current, max) <= 0) break;
    // The trace the owner asked for: a clickable pill in the member's own chat
    // saying it was pulled into this group, one per member per group turn.
    postRoomChip(target.id, current);
    const raw = await askGroupMember(target, { group, roomId: room.id, members }, groupEnvelope(group.name, roster, current));
    const visible = raw.replace(DONE_MARKER_AT_END, "").trim();
    if (!visible || visible === NO_REPLY_MARKER) continue;
    const ledger = rooms.get(room.id);
    if (ledger && !isDuplicateOfLast(ledger, target.id, visible)) rooms.append(room.id, target.id, visible);
    broadcast({ kind: "room", room: rooms.get(room.id) });
    spoke.push({ bot_id: target.id, reply: visible });
    // "that is a job for @Researcher" — the handoff is a real peer message, so
    // the addressee answers in its own time and reports back to the sender.
    // Matched against the whole roster: handing BACK to someone who already
    // spoke, or to a member the mention filtered out, has to work too.
    const stillToAsk = targets.slice(index + 1);
    for (const peer of mentionedBots(visible, roster.filter((bot) => bot.id !== target.id))) {
      const delivery = await deliverPeerMessage(target.id, peer.id, visible, room.id);
      // Only a delivery that actually landed takes the member out of the loop;
      // a refusal must not swallow the handoff and leave nobody working.
      if (delivery.status !== "refused" && stillToAsk.includes(peer)) handedOver.add(peer.id);
    }
  }
  return spoke;
}

/**
 * multibot: okno sklejania. Kilka zdań wysłanych szybko pod rząd to JEDNA tura
 * i JEDNA odpowiedź — tura rusza dopiero, gdy przez `OMB_TURN_DEBOUNCE_MS` nic
 * nowego nie przyszło. W wątku każda wiadomość zostaje osobną bańką; sklejony
 * jest wyłącznie prompt lecący do drivera.
 */
const DEFAULT_TURN_DEBOUNCE_MS = 1500;
const turnDebounceMs = () => {
  const raw = Number(process.env.OMB_TURN_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TURN_DEBOUNCE_MS;
};
const turnDebounce = new Map<string, ReturnType<typeof setTimeout>>();
/** Co poza tekstem czeka na sklejoną turę (załączniki z całego okna). */
type QueuedTurnOptions = {
  attachments: ReturnType<AttachmentStore["resolveMany"]>;
  reasoning?: "low" | "medium" | "high" | "xhigh" | "max";
  actor?: IdentityActor | null;
  /** Kto zaczął turę — peer message nie ma pushować "zaczyna pracę" do usera. */
  origin?: TurnOrigin;
};
const queuedTurnOptions = new Map<string, QueuedTurnOptions>();

function queueUserTurn(botId: string, turnText: string, opts: QueuedTurnOptions): void {
  queuedUserMessages.push(botId, turnText);
  // `busy` zapala się już przy PRZYJĘCIU wiadomości, nie dopiero po oknie
  // sklejania: dla użytkownika bot zabrał się do roboty w chwili wysłania, więc
  // kompozytor blokuje się od razu i nie ma sekundy, w której czat wygląda,
  // jakby wiadomość przepadła.
  if (!store.bot(botId)?.busy) {
    store.patchBot(botId, { busy: true, unread: false });
    broadcast({ kind: "bot", bot: store.bot(botId) });
  }
  const previous = queuedTurnOptions.get(botId);
  queuedTurnOptions.set(botId, {
    attachments: [...(previous?.attachments ?? []), ...opts.attachments],
    reasoning: opts.reasoning ?? previous?.reasoning,
    actor: previous?.actor ?? opts.actor,
    // Sklejone okno z choćby jedną wiadomością człowieka jest turą człowieka.
    origin: previous?.origin === "user" || opts.origin === undefined ? "user" : opts.origin,
  });
  const pending = turnDebounce.get(botId);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    turnDebounce.delete(botId);
    drainQueuedUserMessages(botId);
  }, turnDebounceMs());
  timer.unref?.();
  turnDebounce.set(botId, timer);
}

/** Jedyny model, któremu doklejamy tekst do trwającej tury (spec 0.3.31). */
const STEERABLE_MODEL = "gpt-6-astra";

/**
 * multibot (0.3.31): wepchnij tekst do TRWAJĄCEJ tury bota zamiast czekać na
 * jej koniec. Udaje się tylko wtedy, gdy tura naprawdę żyje (`activeCommsDepth`
 * — samo `busy` zapala już przyjęcie wiadomości), model to GPT-6 Astra i driver
 * pod nim umie `turn/steer`. Każda inna odpowiedź drivera (brak aktywnej tury,
 * `activeTurnNotSteerable`, wyścig z zakończeniem) to `false` i wołający idzie
 * kolejką — dostarczenie jest dokładnie jedno.
 */
async function steerActiveTurn(botId: string, text: string, source: string): Promise<boolean> {
  const bot = store.bot(botId);
  if (!bot?.busy || !activeCommsDepth.has(botId)) return false;
  if (bot.modelSelection.model !== STEERABLE_MODEL) return false;
  const adapter = registry.get(bot.modelSelection.instanceId)?.adapter;
  if (!adapter?.steerTurn || adapter.capabilities.steering !== "same-turn") return false;
  let outcome: "accepted" | "unavailable";
  try {
    outcome = await adapter.steerTurn(bot.threadId, text);
  } catch {
    return false;
  }
  if (outcome !== "accepted") return false;
  armBusyWatchdog(botId); // dopisane zadanie wydłuża turę — nie zwalniaj jej za 70 s
  broadcast({ kind: "turn.steered", botId, threadId: bot.threadId, source });
  return true;
}

/**
 * Dostarcz tekst botowi: do żywej tury (steering), a gdy się nie da — do
 * istniejącej kolejki. Wspólne wejście dla wiadomości użytkownika i wyników
 * asynchronicznych jobów, żeby obie ścieżki miały tę samą regułę i ten sam
 * fallback.
 */
async function deliverToActiveTurnOrQueue(
  botId: string,
  text: string,
  source: string,
  queueOpts: QueuedTurnOptions,
): Promise<"steered" | "queued"> {
  if (await steerActiveTurn(botId, text, source)) return "steered";
  queueUserTurn(botId, text, queueOpts);
  return "queued";
}

function drainQueuedUserMessages(botId: string) {
  const pending = turnDebounce.get(botId);
  if (pending) {
    clearTimeout(pending);
    turnDebounce.delete(botId);
  }
  const bot = store.bot(botId);
  if (!bot) {
    // bot usunięty w międzyczasie — kolejka gaśnie z nim
    queuedUserMessages.take(botId);
    queuedTurnOptions.delete(botId);
    groupTurn.get(botId)?.done("");
    return;
  }
  // Tura już chodzi: nic nie zabieramy z kolejki, jej koniec zawoła nas znowu.
  // `busy` tu nie wystarczy — zapala je już przyjęcie wiadomości; ŻYWĄ turę
  // znaczy wpis w `activeCommsDepth`, zakładany i zdejmowany razem z nią.
  if (activeCommsDepth.has(botId)) return;
  const queued = queuedUserMessages.take(botId);
  if (!queued) return;
  const opts = queuedTurnOptions.get(botId);
  queuedTurnOptions.delete(botId);
  // `startTurn` sam zapala `busy` w tym samym ticku — zdejmujemy je tuż przed,
  // żeby jego własna bramka „bot już pracuje" nie odrzuciła sklejonej tury.
  store.patchBot(botId, { busy: false });
  startTurn(botId, combineQueuedMessages(queued), {
    userMessagePosted: true,
    ...(opts?.attachments.length ? { attachments: opts.attachments } : {}),
    ...(opts?.reasoning ? { reasoning: opts.reasoning } : {}),
    ...(opts?.actor ? { actor: opts.actor } : {}),
    ...(opts?.origin ? { origin: opts.origin } : {}),
  }).catch(() => {
    // Tura nie ruszyła (bot zniknął, dostawca padł) — `busy` już zgasło wyżej,
    // ale UI wciąż widzi zapalone z chwili przyjęcia wiadomości.
    groupTurn.get(botId)?.done("");
    broadcast({ kind: "bot", bot: store.bot(botId) });
  });
}
const bootFleet = await registry.describe();
bootSelection = await defaultSelection(bootFleet);
// Legacy OpenCode Go used a visible custom-model instance. Move only its selection;
// bots, messages and memory keep their existing records.
for (const bot of store.bots) {
  if (bot.modelSelection.instanceId !== "opencodeGo") continue;
  const oldModel = bot.modelSelection.model;
  const model = oldModel.startsWith("opencode/") || oldModel.startsWith("opencode-go/")
    ? oldModel
    : `opencode-go/${oldModel}`;
  store.patchBot(bot.id, { modelSelection: { instanceId: "opencode", model } });
}
// multibot (G1): legacy bots sat on instances that no longer exist — the
// removed `slafy`/`local` engine instance among them. Repair before the first API
// response, preferring a named custom model.
store.migrateOrphanedSelections(bootFleet);
// Keep persisted Claude selections inside four stable UI entries. The driver
// translates these product IDs to Claude Code aliases at execution time.
for (const bot of store.bots) {
  if (bot.modelSelection.instanceId !== "claude") continue;
  const model = bot.modelSelection.model;
  const stable = model === "opus" || model.startsWith("claude-opus-") ? "claude-opus-5"
    : model === "haiku" || model.startsWith("claude-haiku-") ? "claude-haiku-4-5"
      : model === "fable" || model.startsWith("claude-fable-") ? "claude-fable-5-1"
        : model === "sonnet" || model.startsWith("claude-sonnet-") ? "claude-sonnet-5"
          : model;
  if (stable !== model) store.patchBot(bot.id, { modelSelection: { instanceId: "claude", model: stable } });
}
const codexCatalog = bootFleet.find((provider) => provider.instanceId === "codex")?.models;
if (codexCatalog) {
  const valid = new Set(codexCatalog.options.map((option) => option.id));
  for (const bot of store.bots) {
    if (bot.modelSelection.instanceId === "codex" && !valid.has(bot.modelSelection.model)) {
      store.patchBot(bot.id, { modelSelection: { instanceId: "codex", model: codexCatalog.default } });
    }
  }
}
const openCodeModels = bootFleet.find((provider) => provider.instanceId === "opencode")?.models;
if (openCodeModels && openCodeCatalog.lastRefreshSucceeded) {
  const valid = new Set(openCodeModels.options.map((option) => option.id));
  for (const bot of store.bots) {
    if (bot.modelSelection.instanceId !== "opencode" || valid.has(bot.modelSelection.model)) continue;
    const prefix = bot.modelSelection.model.startsWith("opencode/") ? "opencode/" : "opencode-go/";
    const replacement = openCodeModels.options.find((option) => option.id.startsWith(prefix))?.id;
    if (replacement) store.patchBot(bot.id, { modelSelection: { instanceId: "opencode", model: replacement } });
  }
}
store.seedIfEmpty();

// ── SSE fan-out to clients ─────────────────────────────────────────────
// One ephemeral workspace snapshot is shared by the desktop and mobile
// clients. It is never written to chat history or provider event logs.
let fleetEnvironmentRevision = 0;
let fleetEnvironment: FleetEnvironment = {
  ...buildFleetEnvironment(store.bots),
  revision: fleetEnvironmentRevision,
};

function publicFleetEnvironment(): FleetEnvironment {
  return fleetEnvironmentForBots(
    fleetEnvironment,
    store.bots.filter((bot) => bot.visibility !== "private"),
  );
}

function fleetEnvironmentForActor(actor: IdentityActor | null): FleetEnvironment {
  return fleetEnvironmentForBots(
    fleetEnvironment,
    store.bots.filter((bot) => canReadBot(bot, actor)),
  );
}

type EventClient = { res: ServerResponse; actor: IdentityActor | null };

function eventVisible(payload: unknown, actor: IdentityActor | null): boolean {
  if (!payload || typeof payload !== "object") return true;
  const event = payload as Record<string, any>;
  if (event.kind === "environment.snapshot") {
    const snapshotBots = Array.isArray(event.environment?.bots) ? event.environment.bots : [];
    return snapshotBots.every((entry: any) => canReadBot(store.bot(String(entry?.id ?? "")), actor));
  }
  const botFor = (id: unknown) => {
    if (typeof id !== "string") return null;
    return store.bot(id) ?? (id.startsWith("mb-") ? store.botByThread(id.slice(3)) : null);
  };
  if (event.kind === "bot") return canReadBot(event.bot as BotRecord, actor);
  if (event.kind === "bot.deleted") {
    if (event.visibility !== "private") return Boolean(actor);
    return canReadBot({
      id: String(event.botId ?? ""),
      threadId: "",
      name: "",
      title: "",
      description: "",
      notifications: false,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "", model: "" },
      visibility: "private",
      ownerId: typeof event.ownerId === "string" ? event.ownerId : undefined,
      allowedUserIds: Array.isArray(event.allowedUserIds) ? event.allowedUserIds : [],
      messages: [],
    } as unknown as BotRecord, actor);
  }
  if (event.kind === "message" || event.kind === "message.patch") {
    const threadId = String(event.threadId ?? "");
    const bot = store.botByThread(threadId) ?? store.bot(isolatedTurnBots.get(threadId) ?? "");
    return bot ? canReadBot(bot, actor) : true;
  }
  if (event.kind === "runtime") {
    const threadId = String(event.event?.threadId ?? "");
    const bot = store.botByThread(threadId) ?? store.bot(isolatedTurnBots.get(threadId) ?? "");
    return bot ? canReadBot(bot, actor) : true;
  }
  // multibot: banerka niesie tytuł i treść od bota — prywatny bot nie może jej
  // rozesłać całemu workspace'owi. Ten sam zasięg co push (`pushForBot`).
  if (event.kind === "notify") return canReadBot(botFor(event.botId), actor);
  if (event.kind === "screen" || event.kind === "workspace" || event.kind === "computer") {
    if (event.kind === "screen") return canReadBot(botFor(event.botId), actor);
    return event.kind === "workspace" && event.botId === undefined
      ? Boolean(actor)
      : canReadBot(botFor(event.botId), actor);
  }
  if (event.kind === "goal") {
    const bot = store.botByThread(String(event.goal?.ownerThread ?? ""));
    return bot ? canReadBot(bot, actor) : true;
  }
  if (event.kind === "room") {
    const ids = Array.isArray(event.room?.bot_ids) ? event.room.bot_ids : [];
    return ids.length === 0 || ids.every((id: unknown) => canReadBot(botFor(id), actor));
  }
  if (event.kind === "group") {
    const ids = Array.isArray(event.group?.bot_ids) ? event.group.bot_ids : [];
    return ids.length === 0 || ids.every((id: unknown) => canReadBot(botFor(id), actor));
  }
  return true;
}

const sseClients = new Set<EventClient>();
let eventSequence = 0;
function broadcast(payload: unknown) {
  const sequenced = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), sequence: ++eventSequence }
    : payload;
  const text = JSON.stringify(sequenced);
  const frame = `data: ${text}\n\n`;
  for (const client of [...sseClients]) {
    if (!eventVisible(sequenced, client.actor)) continue;
    try {
      client.res.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
  // ten sam strumień po WS — SSE nie przechodzi przez buforujące tunele
  broadcastWs(text);
}

function refreshFleetEnvironment(): void {
  fleetEnvironmentRevision += 1;
  fleetEnvironment = {
    ...buildFleetEnvironment(store.bots),
    revision: fleetEnvironmentRevision,
  };
  broadcast({ kind: "environment.snapshot", environment: publicFleetEnvironment() });
}

const fleetEnvironmentTimer = setInterval(refreshFleetEnvironment, FLEET_ENVIRONMENT_REFRESH_MS);
fleetEnvironmentTimer.unref?.();

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
const toolMessageByItem = new Map<string, string>(); // itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // requestId -> messageId
const approvalRuleByRequest = new Map<string, ApprovalRuleCandidate>();
// multibot: pytania zadane przez bota narzędziem `ask_user`. Wcześniej takie
// pytanie niósł WYŁĄCZNIE broker uprawnień claude'a — a ten montuje się tylko
// przy włączonych zgodach i tylko u claude'a, więc bot na driverze ACP (grok)
// nie miał czym zapytać właściciela i odpowiadał sobie sam. Zadanie pytania
// nie jest uprawnieniem, więc mieszka tu, razem z resztą narzędzi warsztatu, i
// działa u każdego drivera, który montuje serwer `agents`.
const pendingUserAsks = new Map<string, (answer: string) => void>();
const pendingCredentials = new Map<string, { botId: string; resolve: (value: string) => void }>();
// ponytail: cztery minuty, bo `fetch` w proxy ma domyślny headersTimeout 300 s
// — dłuższe trzymanie odpowiedzi zerwałoby połączenie po stronie klienta.
// Trzeba dłużej: pętla odpytująca po `requestId` zamiast jednego wiszącego
// żądania.
const USER_ASK_TIMEOUT_MS = 4 * 60_000;
const USER_ASK_TIMEOUT_NOTE = "MultiBot: nobody answered in time. Use your best judgment and continue.";
const USER_ASK_DISMISS_NOTE = "MultiBot: the user closed the question without answering. Use your best judgment and continue.";

/**
 * Karta w czacie + czekanie na człowieka. Wspólne dla `ask_user` i przekazania
 * komputera (`hand_over_computer`): jeden mechanizm `requestId`, jeden timeout,
 * jedna droga zamknięcia karty. Zwraca tekst, który wraca do bota jako wynik
 * narzędzia.
 */
// ── multibot: push na telefon (U28+) ──────────────────────────────────
// JEDNO miejsce wysyłki powiadomień: sprawdza przełącznik bota, tytułem jest
// nazwa bota, a `data.botId` pozwala aplikacji otworzyć po tapnięciu właśnie
// tego bota. Wysyłka nigdy nie przerywa obsługi zdarzenia.
type PushKind = "question" | "handoff" | "approval" | "started" | "finished" | "failed" | "attention" | "reminder" | "notify";
function pushForBot(botId: string, kind: PushKind, body: string): void {
  const bot = store.bot(botId);
  // `=== false` a nie `!`: boty zapisane zanim pole istniało nie mają go w JSON
  if (!bot || bot.notifications === false) return;
  const audience = bot.visibility === "private" && bot.ownerId ? [bot.ownerId] : undefined;
  void notifyPushDevices(bot.name || "Bot", body.slice(0, 300) || "…", bot.id, { botId: bot.id, kind }, audience).catch(() => {});
}

/** multibot: JEDNO wyjście dla „powiedz człowiekowi coś TERAZ" — przypomnienie
 * i `notify_user`. Push leci na telefon, ramka SSE budzi powłokę na pulpicie
 * (Electron rysuje banerkę systemową). Nie zapisuje wiadomości w czacie: tekst
 * pisze sam bot w swojej turze. */
function notifyUser(botId: string, title: string, body: string, kind: "reminder" | "notify"): void {
  // Wyciszony bot milczy na OBU drogach — push bramkuje `pushForBot`, banerkę
  // trzeba tu, bo `notifyFrame` zna tylko globalny przełącznik powłoki.
  if (store.bot(botId)?.notifications === false) return;
  pushForBot(botId, kind, body || title);
  broadcast({ kind: "notify", botId, title, body });
}

/** Konektory, o których podłączenie bot może poprosić kartą (`request_connection`).
 * Enum jest zamknięty: karta prowadzi do konkretnego miejsca w interfejsie, a
 * nie do dowolnego stringa od modelu. */
const CONNECTION_TARGETS: Record<ConnectorTarget, { pl: string; en: string }> = {
  composio: { pl: "Aplikacje (Composio)", en: "Apps (Composio)" },
  "google-workspace": { pl: googleWorkspace.GOOGLE_WORKSPACE_NAME, en: googleWorkspace.GOOGLE_WORKSPACE_NAME },
  mcp: { pl: "Własny serwer MCP", en: "Your own MCP server" },
  computer: { pl: "Komputer", en: "Computer" },
};
const isConnectorTarget = (value: string): value is ConnectorTarget =>
  Object.prototype.hasOwnProperty.call(CONNECTION_TARGETS, value);
/** A Composio toolkit slug — `discord`, `slack`, `gmail`, `google_sheets`…
 * Models name the APP they need, not the panel it lives behind, and refusing
 * them ("I did not recognize the connector name") is a dead end for the user
 * as much as for the bot. Anything slug-shaped routes to the Composio card
 * with the app named on it; the four fixed targets keep their own panels. */
const TOOLKIT_SLUG = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/i;
/** "google_sheets" → "Google Sheets" for the card title. */
const toolkitLabel = (slug: string): string =>
  slug.split(/[_-]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

// Kto zaczął turę: tury bot-bot (`ask_bot`, runda grupy, cel) nie pushują
// startu ani końca — rozmowa trzech botów dałaby sześć powiadomień. Rozgrzewka
// (`warmBot`) omija `startTurn`, więc nie trafia do mapy i też nie pushuje.
type TurnOrigin = "user" | "routine" | "bot";
const turnOrigin = new Map<string, TurnOrigin>();
const startedPushTimers = new Map<string, ReturnType<typeof setTimeout>>();
function cancelStartedPush(botId: string): void {
  const timer = startedPushTimers.get(botId);
  if (timer) clearTimeout(timer);
  startedPushTimers.delete(botId);
}
/** Anty-zalew: bot, który odpowiedział w < 5 s, wysyła tylko „koniec". */
function scheduleStartedPush(botId: string, body: string): void {
  cancelStartedPush(botId);
  const timer = setTimeout(() => {
    startedPushTimers.delete(botId);
    pushForBot(botId, "started", body);
  }, 5_000);
  timer.unref?.();
  startedPushTimers.set(botId, timer);
}
function endTurnPush(botId: string, kind: "finished" | "failed", body: string): void {
  const origin = turnOrigin.get(botId);
  turnOrigin.delete(botId);
  cancelStartedPush(botId);
  if (!origin || origin === "bot") return;
  pushForBot(botId, kind, body);
}

async function askOwnerAndWait(threadId: string, card: Omit<OptionCardData, "requestId">): Promise<string> {
  const requestId = newId();
  const message = store.appendMessage(threadId, { role: "bot", kind: "options", card: { ...card, requestId } });
  broadcast({ kind: "message", threadId, message });
  // pytanie / przekazanie komputera idzie na telefon także z tury izolowanej
  // (grupa, pokój) — o odpowiedź prosi człowieka, nie drugiego bota
  const asker = store.botByThread(threadId) ?? store.bot(isolatedTurnBots.get(threadId) ?? "");
  if (asker) pushForBot(asker.id, card.kind === "computer-handoff" ? "handoff" : "question", card.subtitle || card.title);
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingUserAsks.delete(requestId)) return;
      // karta bez odpowiedzi zostaje w czacie na zawsze i przyjmuje kliknięcia,
      // które nie mają już gdzie trafić — zamykamy ją
      const patched = store.patchMessage(threadId, message.id, { card: { ...message.card!, dismissed: true } });
      if (patched) broadcast({ kind: "message", threadId, message: patched });
      resolve(USER_ASK_TIMEOUT_NOTE);
    }, USER_ASK_TIMEOUT_MS);
    pendingUserAsks.set(requestId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function askCredentialAndWait(bot: BotRecord, target: CredentialTargetId): Promise<string> {
  const requestKey = newId();
  const meta = CREDENTIAL_TARGETS[target];
  const message = store.appendMessage(bot.threadId, {
    role: "bot",
    kind: "secret",
    secret: { target, ...meta, requestKey },
  });
  broadcast({ kind: "message", threadId: bot.threadId, message });
  pushForBot(bot.id, "question", meta.label);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingCredentials.delete(requestKey)) return;
      const patched = store.patchMessage(bot.threadId, message.id, { secret: { ...message.secret!, dismissed: true } });
      if (patched) broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      resolve("MultiBot: credential request expired.");
    }, USER_ASK_TIMEOUT_MS);
    pendingCredentials.set(requestKey, { botId: bot.id, resolve: (value) => { clearTimeout(timer); resolve(value); } });
  });
}
// multibot (F12): model faktycznie użyty w bieżącej turze (z `session.started`)
// — przypinany do odpowiedzi bota, żeby badge pokazywał realny model.
const turnModelByThread = new Map<string, string>();

bus.subscribe((event: RuntimeEvent) => {
  recordInspectorEvent(event);
  broadcast({ kind: "runtime", event });
  if (event.type === "turn.completed" || event.type === "runtime.error") {
    const gatedBotId = store.botByThread(event.threadId)?.id;
    if (gatedBotId) releaseTurnSlot(gatedBotId);
  }
  const bot = store.botByThread(event.threadId);
  const usageBot = bot ?? (isolatedTurnBots.get(event.threadId) ? store.bot(isolatedTurnBots.get(event.threadId)!) : undefined);
  if (usageBot && event.type === "thread.token-usage.updated") workspace.recordTokens(usageBot.id, event.input, event.output);
  if (usageBot && event.type === "turn.completed") workspace.recordTurn(usageBot.id);
  recordTurnEvent(event);
  if (event.type === "turn.completed" || event.type === "runtime.error") isolatedTurnBots.delete(event.threadId);
  if (!bot) return;

  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(event.threadId, m);
    broadcast({ kind: "message", threadId: event.threadId, message });
    return message;
  };

  switch (event.type) {
    case "session.started":
      if (event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId);
      }
      // multibot (F12): badge odpowiedzi — `startTurn` wstawił wpis TYLKO dla
      // tury z override; tutaj podmieniamy go na REALNY model z eventu (żeby
      // badge nie kłamał), a dla zwykłych tur mapa jest pusta → bez badge.
      if (event.model && turnModelByThread.has(event.threadId)) turnModelByThread.set(event.threadId, event.model);
      else turnModelByThread.delete(event.threadId);
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        // multibot: attach any files the bot sent this turn (send_file) to the
        // message so the user can download / open them from the chat.
        const pending = pendingBotAttachments.get(event.threadId);
        pendingBotAttachments.delete(event.threadId);
        const replyModel = turnModelByThread.get(event.threadId);
        turnModelByThread.delete(event.threadId);
        turnAssistantText.set(event.threadId, [...(turnAssistantText.get(event.threadId) ?? []), event.text]);
        // multibot: `[NO REPLY]` to sygnał protokołu bot↔bot ("nie mam nic do
        // dodania"), nie treść — do wątku nie trafia. Siatka bezpieczeństwa
        // peerów czyta `turnAssistantText` POWYŻEJ, więc dostaje sentinel dalej
        // i dalej zamienia go na milczenie (routePeerReply). Załączniki wygrywają:
        // tura, która wysłała plik, zostaje widoczna mimo sentinela.
        //
        // A turn a COLLEAGUE started is hidden in the other sense: what the
        // bot writes there is addressed to that colleague, so it belongs in
        // the room transcript (routePeerReply puts it there) plus a "replied"
        // chip — not as a bubble in the user's private chat, which is what
        // made the chat read like a raw mail relay. It is still STORED hidden,
        // so the next turn's transcript replay remembers what this bot said.
        //
        // Three exclusions, each because the text would otherwise be visible
        // NOWHERE: an entry already `replied` to (the bot answered that peer
        // with a tool, so this prose is for the user), a turn the user also
        // wrote into (steering), and delegation switched off (routePeerReply
        // drops the answer, so the bot's own chat is the only place left).
        const answeringPeer = (peerTurn.get(bot.id) ?? []).some((entry) => !entry.deferred && !entry.replied)
          && !turnUserText.has(event.threadId)
          && canUseIntegration(bot.threadId, "delegation");
        if ((event.text.trim() !== NO_REPLY_MARKER && !answeringPeer) || pending?.length) {
          pushMessage({
            role: "bot",
            kind: "text",
            text: event.text,
            ...(replyModel ? { model: replyModel } : {}),
            ...(pending?.length ? { attachments: pending } : {}),
          });
        } else if (answeringPeer) {
          store.appendMessage(event.threadId, { role: "bot", kind: "text", text: event.text, hidden: true });
        }
      } else if (event.itemType === "tool" && event.itemId) {
        const messageId = toolMessageByItem.get(event.itemId);
        if (messageId) {
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool?.name ?? "tool", ok: event.ok },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(event.itemId);
        }
        // the bot just finished acting — refresh its screen preview now
        pokeScreenPoller(bot.id);
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        turnUsedTool.add(event.threadId);
        const message = pushMessage({ role: "bot", kind: "activity", tool: { name: event.title ?? "tool" } });
        if (event.itemId) toolMessageByItem.set(event.itemId, message.id);
      }
      break;
    case "request.opened": {
      const permission = event.requestType === "permission";
      // multibot: autoweryfikacja przepuszcza CZĘŚĆ próśb o zgodę, które i tak
      // do nas doszły — nie zmienia tego, czy dostawca w ogóle o zgodę pyta
      // (o tym decyduje autonomia bota w turn-policy.ts). Pytania bota
      // (`ask_user`) zostają nietknięte: na nie odpowiada człowiek, zawsze.
      // Opis akcji sklejamy z nazwy narzędzia i streszczenia, bo reguła
      // użytkownika bywa o jednym albo o drugim ("usuwaj pliki", "echo").
      const verdict = permission
        ? decideAction(normalizeAutoVerify(cfg.autoVerify), `${event.tool} ${event.summary}`)
        : null;
      const autoAllow = verdict?.decision === "allow";
      // Karta powstaje TAK CZY TAK: cicha zgoda bez śladu w czacie byłaby tym
      // samym, przed czym autoweryfikacja ma chronić. `answered` to ten sam
      // kształt, którym łata kartę `request.resolved` — ale BEZ `dismissed`,
      // bo odrzucona karta nie renderuje się w ogóle (src/components/OptionCard).
      const autoNote = !autoAllow ? "" : verdict?.rule
        ? t(`Zgoda automatyczna, reguła: "${verdict.rule.when}"`, `Auto-approved by rule: "${verdict.rule.when}"`)
        : t("Zgoda automatyczna: autoweryfikacja jest wyłączona.", "Auto-approved: auto-verify is switched off.");
      const message = pushMessage({
        role: "bot",
        kind: "options",
          card: {
            title: autoAllow ? t("Zgoda automatyczna", "Auto-approved")
              : permission ? t("Wymagana zgoda", "Approval needed") : t("Bot ma pytanie", "Your bot has a question"),
            subtitle: autoNote ? `${event.summary}\n${autoNote}` : event.summary,
            options: permission ? ["Allow", "Deny", "Allow for all"] : event.choices ?? [],
            requestId: event.requestId,
            ...(autoAllow ? { answered: "Allow" } : {}),
          },
      });
      if (event.requestId) askMessageByRequest.set(event.requestId, message.id);
      if (permission && event.requestId && event.approvalRule) approvalRuleByRequest.set(event.requestId, event.approvalRule);
      if (autoAllow) {
        // Dokładnie ta droga, którą idzie `POST /api/bots/:id/respond` dla
        // `behavior: "allow"`. Bez powiadomienia: sens autoweryfikacji jest
        // taki, żeby telefon nie zapiszczał o czymś, na co zgoda już poszła.
        const instance = registry.get(bot.modelSelection.instanceId);
        if (instance && event.requestId) {
          void instance.adapter
            .respondToRequest(bot.threadId, event.requestId, { behavior: "allow" })
            .catch(() => {
              /* dostawca zniknął w międzyczasie — turę domknie jego własny
                 timeout albo `runtime.error`, karta zostaje jako ślad */
            });
        }
        break;
      }
      pushForBot(bot.id, permission ? "approval" : "question",
        event.summary || (permission ? t("Bot prosi o zgodę.", "The bot needs approval.") : t("Bot ma pytanie.", "The bot has a question.")));
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(event.requestId) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          const patched = store.patchMessage(event.threadId, messageId, {
            card: {
              ...existing.card,
              answered: event.behavior === "always" ? "Allow for all"
                : event.behavior === "allow" ? "Allow"
                  : event.behavior === "deny" ? "Deny"
                    : event.behavior,
              dismissed: event.source !== "user",
            },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
        }
        if (event.requestId) askMessageByRequest.delete(event.requestId);
      }
      if (event.requestId) approvalRuleByRequest.delete(event.requestId);
      break;
    }
    case "runtime.error":
      // Tura padła: nikt nie odpisze koledze, więc znacznik peer gaśnie razem
      // z nią — inaczej NASTĘPNA, niezwiązana tura wysłałaby swój tekst do
      // nadawcy sprzed awarii.
      peerTurn.delete(bot.id);
      groupTurn.get(bot.id)?.done("");
      turnAssistantText.delete(event.threadId);
      turnUsedTool.delete(event.threadId);
      turnUserText.delete(event.threadId);
      pushMessage({ role: "bot", kind: "activity", tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false } });
      endTurnPush(bot.id, "failed", event.message.slice(0, 120));
      // watchdog: provider padl bez turn.completed -> zwolnij busy
      if (bot) {
        store.patchBot(bot.id, { busy: false });
        if (busyWatchdog.has(bot.id)) { clearTimeout(busyWatchdog.get(bot.id)!); busyWatchdog.delete(bot.id); }
        activeCommsDepth.delete(bot.id);
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
        // multibot: nieudana tura zwalnia bota tak samo jak udana, więc musi
        // tak samo ruszyć to, co czekało w kolejkach. Bez tego list od innego
        // bota (albo wiadomość użytkownika) dopisany do kolejki w trakcie tury
        // zostawał w niej bez śladu, dopóki bot nie odbył przypadkiem KOLEJNEJ
        // tury albo serwer się nie zrestartował. Trzy pozostałe miejsca, które
        // zwalniają bota, opróżniają kolejki od zawsze — to jedyne tego nie
        // robiło.
        drainQueuedUserMessages(bot.id);
      }
      break;
    case "turn.completed": {
      // the last live frame becomes a settled inline screen message —
      // the screenshot-in-chat moment
      const frame = stopScreenPoller(bot.id);
      if (frame) pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
      store.patchBot(bot.id, { busy: false, unread: true });
      if (busyWatchdog.has(bot.id)) { clearTimeout(busyWatchdog.get(bot.id)!); busyWatchdog.delete(bot.id); }
      const lastReply = store.messagesFor(bot.threadId).filter((m) => m.role === "bot" && m.kind === "text" && m.text).at(-1)?.text ?? "";
      // Safety net for the whole bot↔bot design: a bot that was answering a
      // peer and did not call a peer tool itself still gets its prose routed
      // back. Without it the most natural thing a model does — just write the
      // answer — would end the conversation in silence.
      //
      // Only text THIS turn produced may go back. `lastReply` walks the whole
      // thread, so a peer turn that ended in tool calls alone would forward the
      // bot's previous, unrelated answer to a bot that never asked for it.
      const saidThisTurn = (turnAssistantText.get(event.threadId) ?? []).join("\n").trim();
      turnAssistantText.delete(event.threadId);
      turnUsedTool.delete(event.threadId);
      turnUserText.delete(event.threadId);
      // A group turn has no peer to answer: the loop that asked is waiting.
      // A turn that was ALREADY running when the envelope queued did not read
      // it, so it only clears the flag; the turn the drain starts answers.
      const groupWaiting = groupTurn.get(bot.id);
      if (groupWaiting?.deferred) groupWaiting.deferred = false;
      else groupWaiting?.done(saidThisTurn);
      const waiting = (peerTurn.get(bot.id) ?? []).filter((entry) => !entry.replied);
      // A message that queued behind THIS turn is read by the next one; it is
      // held over instead of being answered with text written before it landed.
      const answering = waiting.filter((entry) => !entry.deferred);
      const held = waiting.filter((entry) => entry.deferred);
      for (const entry of held) entry.deferred = false;
      if (held.length) peerTurn.set(bot.id, held);
      else peerTurn.delete(bot.id);
      if (answering.length) {
        const mayDelegate = canUseIntegration(bot.threadId, "delegation");
        void (async () => {
          // Every bot still waiting on this turn gets the answer; sequential so
          // the room ledger and the budget see one message at a time.
          for (const entry of answering) await routePeerReply(bot.id, entry, saidThisTurn, mayDelegate);
        })().catch((error) =>
          console.warn(`[multibot] peer reply from ${bot.id} failed:`, error instanceof Error ? error.message : error),
        );
      }
      endTurnPush(bot.id, "finished", lastReply.slice(0, 120) || t("skończył pracę", "finished working"));
      clearTurnPolicy(bot.threadId);
      activeCommsDepth.delete(bot.id); // multibot (F9): tura skończona — licznik też
      turnModelByThread.delete(event.threadId); // multibot (F12): sprzątanie badge
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      if (bot.temporary) {
        // Chwilowy podagent kończy życie po swoim zadaniu, nie dopiero po
        // restarcie serwera; inaczej zaśmieca listę i pliki transkryptu.
        // Kasujemy PRZED drainem: bota już nie ma, więc kolejki gasną razem
        // z nim zamiast odpalać turę na rekordzie, który za chwilę zniknie.
        stopScreenPoller(bot.id);
        harnessRoutines.deleteBot(bot.id);
        attachments.deleteBot(bot.id);
        workspace.deleteBot(bot.id);
        store.deleteBot(bot.id);
        broadcast({ kind: "bot.deleted", botId: bot.id, visibility: bot.visibility, ownerId: bot.ownerId, allowedUserIds: bot.allowedUserIds });
      }
      drainQueuedUserMessages(bot.id); // multibot 0.1.44: spam użytkownika z trakcie tury
      break;
    }
  }
});

// ── live screen: poll the bot's box while it works ────────────────────
// Frames stream to clients as SSE {kind:'screen'} (the "Bot's screen"
// panel); the final frame is folded into the transcript on turn end.
type Frame = { png: string; mime: string };
const screenPollers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; capture: () => Promise<void>; last: Frame | null }
>();

function startScreenPoller(botId: string) {
  if (screenPollers.has(botId) || !box.boxConfigured(cfg)) return;
  let inFlight = false;
  const capture = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { png, format } = await box.screenshotBox(cfg, botId);
      const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
      entry.last = frame;
      broadcast({ kind: "screen", botId, ...frame });
    } catch {
      /* box asleep or mid-command — try again next tick */
    } finally {
      inFlight = false;
    }
  };
  const entry = {
    timer: setInterval(capture, 4000),
    capture,
    last: null as Frame | null,
  };
  screenPollers.set(botId, entry);
}

/** Event-driven refresh: capture NOW (the bot just acted on its screen)
 * instead of waiting for the next interval tick. */
function pokeScreenPoller(botId: string) {
  void screenPollers.get(botId)?.capture();
}

function stopScreenPoller(botId: string): Frame | null {
  const entry = screenPollers.get(botId);
  if (!entry) return null;
  clearInterval(entry.timer);
  screenPollers.delete(botId);
  return entry.last;
}

// multibot (H1): the Electron-hosted local CUA ("this Mac") is gone from the
// turn path — a bot acts on its own computer, never on the user's desktop.
// electron/cua.mjs and its connection file stay on disk; driving the host's
// physical screen is explicitly deferred, not deleted.

// multibot: provider/model switch for chat. `/model` is a
// harness command, not prose sent to whichever provider happens to be active.
// Selection persists on bot, matching the model picker and surviving restart.
async function handleModelCommand(bot: ReturnType<Store["bot"]>, text: string): Promise<string | null> {
  if (!bot || !/^\/model(?:\s|$)/i.test(text)) return null;
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });

  const raw = text.replace(/^\/model\s*/i, "").trim();
  const providerFlag = raw.match(/(?:^|\s)--provider(?:=|\s+)([^\s]+)/i)?.[1]?.toLowerCase();
  // multibot (F12): `/model --once X` = nadpisanie modelu na JEDNĄ turę.
  // Nie zapisuje `modelSelection` — ustawia `pendingModelOverride`, który
  // konsumuje następna wiadomość. Zakres: tylko obecny provider bota.
  const once = /(?:^|\s)--once(?:\s|$)/i.test(raw);
  const target = raw
    .replace(/(?:^|\s)--(?:provider(?:=|\s+)[^\s]+|global|session|once|refresh)(?=\s|$)/gi, "")
    .trim();
  const described = await registry.describe();
  const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "");
  const aliases: Record<string, string> = {
    anthropic: "claude",
    openai: "codex",
    chatgpt: "codex",
    google: "gemini",
    xai: "grok",
    moonshot: "kimi",
    alibaba: "qwen",
  };
  const findProvider = (value: string) => {
    const wanted = aliases[key(value)] ?? key(value);
    return described.find((item) =>
      [item.instanceId, item.driverKind, item.displayName].some((candidate) => key(candidate) === wanted),
    );
  };
  const current = described.find((item) => item.instanceId === bot.modelSelection.instanceId);

  if (!raw) {
    const lines = described.map((item) => {
      const models = item.models.options.map((model) => model.id).join(", ") || "no catalog";
      const status = item.snapshot.state === "available" ? "ready" : `unavailable: ${item.snapshot.reason ?? "not ready"}`;
      return `- ${item.displayName ?? item.instanceId}: ${models} (${status})`;
    });
    return `Current model: ${bot.modelSelection.model || "unknown"}\nProvider: ${current?.displayName ?? (bot.modelSelection.instanceId || "unknown")}\n\n${lines.join("\n")}\n\nUse /model <provider>/<model> or /model <model> --provider <provider>.`;
  }

  const exactOption = providerFlag
    ? undefined
    : described.find((item) => item.models.options.some((option) =>
      option.id.toLowerCase() === target.toLowerCase() || option.label.toLowerCase() === target.toLowerCase()));
  let provider = providerFlag ? findProvider(providerFlag) : exactOption;
  let model = exactOption?.models.options.find((option) =>
    option.id.toLowerCase() === target.toLowerCase() || option.label.toLowerCase() === target.toLowerCase())?.id ?? target;
  if (!provider && target.includes("/")) {
    const slash = target.indexOf("/");
    const candidate = findProvider(target.slice(0, slash));
    if (candidate) {
      provider = candidate;
      model = candidate.instanceId === "opencode" && candidate.models.options.some((option) => option.id === target)
        ? target
        : target.slice(slash + 1);
    }
  }
  if (!provider && target.includes(":")) {
    const colon = target.indexOf(":");
    const candidate = findProvider(target.slice(0, colon));
    if (candidate) {
      provider = candidate;
      model = target.slice(colon + 1);
    }
  }
  if (!provider && !providerFlag) {
    provider = described.find((item) => item.instanceId === bot.modelSelection.instanceId &&
      item.models.options.some((option) => option.id === target || option.label.toLowerCase() === target.toLowerCase()));
    provider ??= described.find((item) => item.models.options.some((option) => option.id === target || option.label.toLowerCase() === target.toLowerCase()));
  }
  if (!provider && providerFlag) return `Unknown provider: ${providerFlag}. Use /model to list providers.`;
  if (!provider) return `Unknown model: ${target}. Use /model to list providers and models.`;
  if (provider.snapshot.state !== "available") {
    return `${provider.displayName ?? provider.instanceId} unavailable: ${provider.snapshot.reason ?? "not ready"}`;
  }
  if (!model) model = provider.models.default;
  const known = provider.models.options.some((option) => option.id === model || option.label.toLowerCase() === model.toLowerCase());
  if (!known && provider.models.options.length) {
    return `Unknown ${provider.displayName ?? provider.instanceId} model: ${model}. Available: ${provider.models.options.map((option) => option.id).join(", " )}`;
  }
  const selectedModel = provider.models.options.find((option) => option.id === model || option.label.toLowerCase() === model.toLowerCase())?.id ?? model;
  if (once) {
    // multibot (F12): jednorazowe nadpisanie działa tylko w obrębie OBECNEGO
    // providera bota — przełączenie dostawcy zostaje wyłącznie dla trwałego
    // `/model` (bez --once). Komunikat mówi to wprost, żeby nie było cichego no-op.
    if (provider.instanceId !== bot.modelSelection.instanceId) {
      return `One-shot override is limited to this bot's current provider (${current?.displayName ?? bot.modelSelection.instanceId}). To switch providers, use /model without --once.`;
    }
    store.patchBot(bot.id, { pendingModelOverride: selectedModel });
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
    return `Model for the next task: ${selectedModel} (one turn only). ${provider.displayName ?? provider.instanceId}`;
  }
  store.patchBot(bot.id, { modelSelection: { instanceId: provider.instanceId, model: selectedModel } });
  broadcast({ kind: "bot", bot: store.bot(bot.id) });
  return `Model switched to: ${selectedModel}\nProvider: ${provider.displayName ?? provider.instanceId}`;
}

// ── /goal: persistent multi-turn goal pursuit ───────────────────────────
// A goal is not one reply: the harness runs the bot for several turns, each
// turn advancing the same task with the full progress so far. The loop is a
// sibling of the peer conversation — same askBotAndWait, same isolated goal
// thread, same done-marker protocol — but with hard budgets and durable
// progress so `--resume` can continue after a restart.

/** "Ultra-persistence" ladder + budgets injected into every goal turn. */
function goalPrompt(goal: GoalRecord, bot: { id: string; name: string }): string {
  const o = goal.options;
  const done = goal.notes.map((n) => `- step ${n.step}: ${n.text}`).join("\n");
  const ladder = o.computerOnly
    ? "This goal is computer-only: work through your computer (browser, terminal, files). Skip web search and CLI shortcuts — the user wants the machine used."
    : o.noComputer
      ? "This goal is computer-free: use web search, CLI and file tools only. Do not reach for the computer."
      : `Escalate until you succeed: 1) web search / CLI / file tools, 2) your computer — browse, read files, run commands in its terminal, WITHOUT asking first (it is your machine), 3) other bots (${o.collab ? "start_collab, ask_bot" : "ask_bot"}) — bring one in whenever a peer knows the domain better or the work splits cleanly${o.agents > 0 ? `, 4) temporary subagents (create_agent, up to ${o.agents} in parallel)` : ""}. Stop only when every path that could plausibly work is exhausted, then state plainly what blocked you.`;
  const autonomy = o.auto
    ? "Autonomous mode: make decisions and continue without asking the user. Ask only for data you cannot obtain any other way."
    : o.ask
      ? "Ask the user before consequential actions; wait for their answer."
      : "Ask the user only when you genuinely need their decision or data you have no way to obtain (a password, a direction, consent for something irreversible).";
  const plan = o.plan && goal.stepCount === 0
    ? "First turn is PLANNING: break the goal into concrete, ordered steps and present the plan. Then start executing it."
    : "";
  const teach = o.teach
    ? "When the goal is achieved, create a reusable skill (`create_skill`) capturing the approach that worked."
    : "";
  const budgets = `Hard budgets: ~${o.steps} tool steps, ${o.turns} turns, ${o.time} minutes. Track your own progress; when a budget is nearly spent, wrap up with the best result you have.`;
  return [
    `You are @${bot.name} in a MultiBot goal session. The user gave you a goal: ${goal.task}`,
    plan,
    "Work on this goal now — each turn continues the same task. Build on your previous steps below.",
    done ? `Progress so far:\n${done}` : "No progress yet — this is the first turn.",
    ladder,
    autonomy,
    budgets,
    teach,
    "Never claim you did something you did not; if something failed, say plainly what and why. Persistence is not permission bypass: a disabled toolset stays disabled.",
    `When the goal is fully achieved, end your message with the exact line: ${GOAL_DONE_MARKER}`,
  ].filter(Boolean).join("\n\n");
}

/** Count tool steps spent in a goal thread from its activity messages. */
function goalStepsUsed(goalId: string, botId: string): number {
  return store
    .messagesFor(goalThreadId(goalId, botId))
    .filter((m) => m.kind === "activity").length;
}

/** Progress pill on the owner's chat: "Goal step 3/8 — <what happened>". */
function postGoalPill(goal: GoalRecord, detail: string) {
  const message = store.appendMessage(goal.ownerThread, {
    role: "bot",
    kind: "event",
    event: { type: "goal-progress", value: detail },
    // Ten sam tekst również jako `text`: nowe klienty rysują pigułkę po
    // `kind`, a starsze (aplikacja na telefon jedzie własną paczką interfejsu
    // i bywa kilka wersji z tyłu) wpadają w gałąź domyślną i bez tego pola
    // pokazywały pusty dymek na każdy postęp celu.
    text: `Goal — ${detail}`,
  });
  broadcast({ kind: "message", threadId: goal.ownerThread, message });
}

/** Final report on the owner's chat once the goal settles. */
function postGoalReport(goal: GoalRecord) {
  const summary = goal.notes.length
    ? goal.notes.map((n) => `- ${n.text}`).join("\n")
    : "(no steps were completed)";
  const statusText =
    goal.status === "done" ? "Goal achieved" :
    goal.status === "blocked" ? "Goal blocked — waiting on you" :
    goal.status === "failed" ? `Goal stopped: ${goal.reason ?? "budget exhausted"}` : "Goal";
  const message = store.appendMessage(goal.ownerThread, {
    role: "bot",
    kind: "text",
    text: `**${statusText}** — ${goal.task}\n\n${summary}${goal.reason ? `\n\nReason: ${goal.reason}` : ""}\n\nRun \`/goal --resume\` to continue where it stopped.`,
  });
  broadcast({ kind: "message", threadId: goal.ownerThread, message });
}

/** Run a goal to settlement: turns until the bot marks it done, a budget
 * runs out, the TTL lapses, or the bot waits on the user. Busy bots are
 * skipped for that round; two consecutive idle rounds give up. */
async function runGoal(goalId: string): Promise<void> {
  const started = Date.now();
  const SAFETY_MS = 2 * 60 * 60_000;
  let idleRounds = 0;
  for (;;) {
    const goal = goals.get(goalId);
    if (!goal || goal.status !== "running") break;
    if (Date.now() >= goal.expiresAt) {
      goals.setStatus(goalId, "failed", "time budget exceeded");
      break;
    }
    if (Date.now() - started >= SAFETY_MS) {
      goals.setStatus(goalId, "failed", "safety ceiling reached");
      break;
    }
    if (goal.stepCount >= goal.options.turns) {
      goals.setStatus(goalId, "failed", `turn budget exceeded (${goal.options.turns})`);
      break;
    }
    if (goalStepsUsed(goalId, goal.botId) >= goal.options.steps) {
      goals.setStatus(goalId, "failed", `tool-step budget exceeded (${goal.options.steps})`);
      break;
    }
    const bot = store.bot(goal.botId);
    if (!bot) {
      goals.setStatus(goalId, "failed", "bot was deleted");
      break;
    }
    if (bot.busy) {
      // Bot jest w środku cudzej tury. Czekamy do dwóch minut, bo najzwyklejszy
      // przypadek to użytkownik, który dopisał zwykłą wiadomość w trakcie celu
      // — dwie rundy po pięć sekund zabijały cel po dziesięciu sekundach.
      idleRounds++;
      if (idleRounds >= IDLE_ROUNDS_LIMIT) {
        goals.setStatus(goalId, "blocked", "bot stayed busy for two minutes");
        break;
      }
      await new Promise((r) => setTimeout(r, IDLE_WAIT_MS));
      continue;
    }
    idleRounds = 0;
    const reply = await askBotAndWait(goal.botId, goalPrompt(goal, bot), 1, {
      threadId: goalThreadId(goalId, goal.botId),
      transcript: goal.notes.map((n) => ({ role: "assistant" as const, text: n.text })),
    });
    const current = goals.get(goalId);
    if (!current || current.status !== "running") {
      break;
    }
    const markerAt = reply.indexOf(GOAL_DONE_MARKER);
    const visible = markerAt >= 0 ? reply.slice(0, markerAt).trim() : reply;
    if (visible) {
      goals.appendNote(goalId, visible.slice(0, 2000));
      const note = goals.get(goalId);
      if (note) {
        postGoalPill(note, `step ${note.stepCount}/${note.options.turns}: ${visible.slice(0, 120)}${visible.length > 120 ? "…" : ""}`);
        broadcast({ kind: "goal", goal: note });
      }
    }
    if (markerAt >= 0) {
      goals.setStatus(goalId, "done");
      const done = goals.get(goalId);
      if (done) {
        postGoalPill(done, `goal complete in ${done.stepCount} step(s)`);
        if (done.options.report) postGoalReport(done);
        broadcast({ kind: "goal", goal: done });
      }
      break;
    }
    // The bot parked on a question for the user (needsAttention) — hold.
    const parked = store.bot(goal.botId);
    if (parked?.needsAttention) {
      goals.setStatus(goalId, "blocked", "waiting for you");
      const blocked = goals.get(goalId);
      if (blocked) {
        postGoalPill(blocked, "bot is waiting for you");
        if (blocked.options.report) postGoalReport(blocked);
        broadcast({ kind: "goal", goal: blocked });
      }
      break;
    }
  }
  const final = goals.get(goalId);
  if (final && final.status === "running") {
    goals.setStatus(goalId, final.stepCount ? "failed" : "failed", "no progress made");
    const settled = goals.get(goalId);
    if (settled) broadcast({ kind: "goal", goal: settled });
  }
  const settled = goals.get(goalId);
  if (settled) broadcast({ kind: "goal", goal: settled });
}

/** Harness command handler for `/goal [flags] <task>`. Returns the ack text
 * to show as the bot's reply, or null when the message is not a /goal command. */
async function handleGoalCommand(bot: ReturnType<Store["bot"]>, text: string): Promise<string | null> {
  if (!bot || !/^\/goal(?:\s|$)/i.test(text)) return null;
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });

  const parsed = parseGoalCommand(text);
  if (!parsed) return null;
  if (parsed.resume) {
    const previous = goals.latestFor(bot.id);
    if (!previous) return "No unfinished goal to resume. Start one with `/goal <task>`.";
    goals.setStatus(previous.id, "running");
    const resumed = goals.get(previous.id)!;
    postGoalPill(resumed, "resuming goal");
    void runGoal(resumed.id);
    return `Resuming goal: ${resumed.task}\nProgress so far: ${resumed.stepCount} step(s). Budget: ${resumed.options.turns - resumed.stepCount} turns left, ${resumed.options.steps} steps, ${resumed.options.time} min.`;
  }
  if (!parsed.task) {
    return [
      "Usage: /goal [flags] <task> — I pursue the goal across many turns, escalating until it's done.",
      "Flags:",
      "  --plan          break the goal into steps before executing",
      "  --steps N       hard tool-step budget (default 25)",
      "  --turns N       hard turn limit (default 8)",
      "  --time M        hard time budget in minutes (default 30)",
      "  --auto          decide and continue without asking",
      "  --ask           ask before consequential actions",
      "  --agents N      spawn up to N temporary subagents for parallel work",
      "  --collab        bring peer bots in via collaboration rooms",
      "  --computer-only work through the computer only",
      "  --no-computer   forbid the computer; CLI/web tools only",
      "  --teach         write a reusable skill once the goal is achieved",
      "  --checkpoint N  persist a progress note every N steps",
      "  --no-report     skip the final report message",
      "  --resume        continue the last unfinished goal",
    ].join("\n");
  }
  const goal = goals.create({ botId: bot.id, task: parsed.task, ownerThread: bot.threadId, options: parsed.options });
  postGoalPill(goal, `started: ${parsed.task.slice(0, 120)}${parsed.task.length > 120 ? "…" : ""}`);
  void runGoal(goal.id);
  return `Goal started: ${parsed.task}\nBudgets: ${parsed.options.steps} tool steps, ${parsed.options.turns} turns, ${parsed.options.time} min. I'll keep working and report progress here.`;
}


/**
 * multibot (A2): zimny start CLI kosztuje na telefonie kilkadziesiąt sekund i
 * dotąd płacił go użytkownik PIERWSZĄ wiadomością — po restarcie harnessu i po
 * każdym przełączeniu bota. Rozgrzewka stawia proces zawczasu: nic nie wysyła,
 * niczego nie dopisuje do rozmowy, tylko zostawia gotowy proces.
 *
 * Podpis procesu (server/drivers/claude.ts) zależy od modelu, polityki tury i
 * serwerów MCP, więc liczymy je DOKŁADNIE tak jak tura — inaczej pierwsza tura
 * ubiłaby rozgrzanego workera na niezgodności podpisu i nic byśmy nie ugrali.
 * Jeden świadomy wyjątek: komputer bota. Jego wykrycie znaczy `ensureComputer()`
 * (potrafi stawiać kontener) i leasing agenta, a rozgrzewka nie ma prawa robić
 * ani jednego, ani drugiego. Bot z komputerem dostanie więc podpis inny niż
 * rozgrzany i zapłaci zimny start jak dotąd — nigdy nic gorszego.
 *
 * Zwraca `true`, gdy bot JUŻ był ciepły (albo rozgrzewka go nie dotyczy) — po
 * tym pozna zamiatarka niżej, czy poprzednia próba się utrzymała.
 */
async function warmBot(botId: string): Promise<boolean> {
  const bot = store.bot(botId);
  if (!bot || bot.busy) return true;
  const instance = registry.get(bot.modelSelection.instanceId);
  // Tylko driver, który trzyma proces CLI między turami i rozumie `warmOnly`.
  // Dla pozostałych driverów pusta tura byłaby PRAWDZIWĄ turą do modelu.
  if (!instance || instance.driverKind !== "claudeAgent") return true;
  if (instance.adapter.hasSession?.(bot.threadId)) return true; // już ciepły
  const integrations: TurnIntegrationsLike & Record<string, unknown> = {};
  if (cfg.composio?.key && canUseIntegration(bot.threadId, "integrations")) {
    integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
  }
  if (instance.adapter.capabilities.agentsMcp === true) {
    integrations.agents = agentsIntegration(bot.id);
  }
  // Polityka tury MUSI stać przed spawnem: to z niej driver bierze
  // `permissionMode` i listę wyłączonych narzędzi, a jedno i drugie siedzi w
  // podpisie procesu. Wartości są te same, które ustawi prawdziwa tura.
  setTurnPolicy(bot.threadId, {
    autonomy: workspace.autonomy(bot.id).autonomy,
    access: workspace.access(bot.id).access,
    permissions: workspace.permissions(bot.id),
    approvalRules: workspace.approvalRules(bot.id),
  });
  try {
    await instance.adapter.sendTurn({
      threadId: bot.threadId,
      text: "",
      model: bot.modelSelection.model,
      // Ten sam kursor co tura — inaczej rozgrzalibyśmy proces z NOWĄ sesją, a
      // tura wzięłaby go (kursor nie wchodzi do podpisu) i zgubiła kontekst.
      resumeCursor: bot.resumeCursors[bot.modelSelection.instanceId],
      system: botSystemPrompt(bot, { isolated: false, integrations, workspace, timeZone: cfg.timeZone }),
      integrations,
      warmOnly: true,
    } as Parameters<typeof instance.adapter.sendTurn>[0] & { warmOnly: boolean });
  } finally {
    // Rozgrzewka NIE jest turą, a polityka zostawiona po niej wyglądała jak
    // trwająca tura — na tym stoi bramka trasy narzędzi komputera („brak
    // polityki = nikt nie ma tury"), więc bez tego ciepły proces miałby
    // przeglądarkę i shell między turami. Prawdziwa tura ustawia ją na nowo.
    clearTurnPolicy(bot.threadId);
  }
  return false; // proces dopiero co wstał — czy się utrzymał, pokaże następne zamiatanie
}

/**
 * multibot (A2): rozgrzewka botów — w kolejności ostatniej rozmowy, do limitu
 * żywych workerów. Sekwencyjnie i bez pośpiechu: dwa zimne starty CLI naraz
 * biją się na telefonie o RAM i CPU, więc szeregowo wychodzi szybciej niż
 * równolegle.
 *
 * MULTIBOT_WARM_WORKERS=0 znaczy „każdy bot to ciepły worker": rozgrzewamy
 * WSZYSTKIE boty, a driver nikogo nie eksmituje ani nie ubija z bezczynności.
 * Parsowanie musi się zgadzać z maxWarmWorkers() w drivers/claude.ts — inaczej
 * jedna strona zrozumiałaby 0 jako „dwa".
 */
const warmWorkerLimit = () =>
  process.env.MULTIBOT_WARM_WORKERS ? Number(process.env.MULTIBOT_WARM_WORKERS) || 0 : 2;
const warmColdStreak = new Map<string, number>();
async function warmBots(): Promise<void> {
  const limit = warmWorkerLimit();
  const lastAt = (b: BotRecord) => store.messagesFor(b.threadId).at(-1)?.at ?? b.createdAt;
  const recent = store.bots
    .filter((b) => !b.hidden && !b.temporary)
    .sort((a, b) => lastAt(b) - lastAt(a));
  for (const bot of limit > 0 ? recent.slice(0, limit) : recent) {
    // Bot, który pięć zamiatań z rzędu nie utrzymał procesu, jest odpuszczany:
    // to znaczy, że CLI jest u niego trwale zepsute, a nie że zabrakło pamięci
    // na chwilę — mielenie telefonu w kółko nic tu nie naprawi.
    if ((warmColdStreak.get(bot.id) ?? 0) >= 5) continue;
    const wasWarm = await warmBot(bot.id).catch((e) => {
      console.warn(`[multibot] warmup failed for ${bot.id}:`, e instanceof Error ? e.message : e);
      return false;
    });
    warmColdStreak.set(bot.id, wasWarm ? 0 : (warmColdStreak.get(bot.id) ?? 0) + 1);
  }
}

// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";
const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";

async function startTurn(
  botId: string,
  text: string,
opts?: {
    commsDepth?: number;
    reasoning?: ReasoningLevel;
    attachments?: ReturnType<AttachmentStore["resolveMany"]>;
    threadId?: string;
    transcript?: Array<{ role: "user" | "assistant"; text: string }>;
    /** multibot (F12): jednorazowe nadpisanie modelu na tę turę (bez zmiany
     * `modelSelection`). Same-instance only — instance rozwiązywana jak zwykle. */
    modelOverride?: string;
    /** multibot: wiadomość użytkownika już wisi w wątku, bo tura rusza dopiero
     * po pokoju współpracy, a `text` jest o jego podsumowanie bogatszy niż to,
     * co użytkownik napisał. Bez tego dostawał drugą bańkę z całym transkryptem
     * pokoju, który ma przecież własny, klikalny widok. */
    userMessagePosted?: boolean;
    /** multibot: kto zaczął turę — decyduje o pushach start/koniec. */
    origin?: TurnOrigin;
    /** nazwa rutyny do treści pushu „rutyna X wystartowała" */
    routineName?: string;
    /** Authenticated human who started this turn. */
    actor?: IdentityActor | null;
  },
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  const turnThreadId = opts?.threadId ?? bot.threadId;
  const isolated = turnThreadId !== bot.threadId;
  if (isolated) isolatedTurnBots.set(turnThreadId, bot.id);
  if (bot.busy && !isolated) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
  const commsDepth = opts?.commsDepth ?? 0;
  // multibot (F12): badge zależy od FAKTU użycia override (natural language /
  // `/model --once`), nie od tego, czy model różni się od skonfigurowanego —
  // prośba o model, który bot już ma, też ma dostać badge.
  const hadOverride = Boolean(bot.pendingModelOverride);
  const turnModel = bot.pendingModelOverride ?? bot.modelSelection.model;
  if (hadOverride) turnModelByThread.set(turnThreadId, turnModel);
  if (!isolated && bot.pendingModelOverride) store.patchBot(bot.id, { pendingModelOverride: null });

  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance) {
    throw Object.assign(
      new Error(`provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`),
      { status: 409 },
    );
  }

  const turnAttachments = opts?.attachments ?? [];
  // multibot: tury RÓŻNYCH botów chodzą równolegle. Jedyne, co je ogranicza, to
  // liczba jednoczesnych tur (OMB_MAX_PARALLEL_TURNS) — nie kolejność. Tura
  // zagnieżdżona (izolowana albo delegowana, depth > 0) slotu nie bierze: jej
  // wołający właśnie jeden trzyma, więc czekałaby sama na siebie.
  // ponytail: tura peera to teraz zwykła tura głównego wątku, więc BIERZE slot
  // — rozmowa botów potrafi wygłodzić wiadomość człowieka przy małym
  // OMB_MAX_PARALLEL_TURNS. Sufit świadomy: gdyby doskwierało, należy się
  // osobna pula slotów dla tur o origin "bot", nie zdejmowanie bramki.
  const gated = !isolated && commsDepth === 0;
  const userMessage = isolated || opts?.userMessagePosted ? null : store.appendMessage(bot.threadId, {
    role: "user",
    kind: "text",
    text,
    ...(opts?.actor ? { userId: opts.actor.userId, ...(opts.actor.displayName ? { userName: opts.actor.displayName } : {}) } : {}),
    // multibot (F12): badge na wiadomości usera TYLKO gdy ta tura użyła
    // jawnego override (natural language / `/model --once`) — niezależnie od
    // tego, czy model różni się od skonfigurowanego. Zwykłe tury — bez badge.
    ...(hadOverride ? { model: turnModel } : {}),
    ...(turnAttachments.length ? { attachments: turnAttachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })) } : {}),
  });
  if (userMessage) broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });

  // transcript: settled text turns only. Driverzy API-owi (grok) grają z niego
  // rozmowę co turę, drivery CLI (codex/claude) dostają go tylko wtedy, gdy
  // sesja dostawcy przepadła i trzeba odtworzyć rozmowę od zera. Dlatego CAŁY
  // wątek, przycięty budżetem znaków (OMB_HISTORY_MAX_CHARS) zamiast sztywnym
  // „ostatnie 40" — po 40 wiadomościach bot zapominał początek rozmowy.
  const transcript = opts?.transcript ?? trimTranscript(
    store
      .messagesFor(bot.threadId)
      .filter((m) => m.kind === "text" && m.text && m.id !== userMessage?.id)
      .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text! })),
  );
  const promptUser = opts?.actor
    ? { uid: opts.actor.userId, name: opts.actor.displayName }
    : (() => {
      const lastUser = store.messagesFor(bot.threadId).reverse().find((message) => message.role === "user" && message.userId);
      return lastUser?.userId ? { uid: lastUser.userId, name: lastUser.userName } : undefined;
    })();


  // multibot (D7): kolejna tura usera JEST odpowiedzią na to, na co bot czekał
  if (!isolated && bot.needsAttention != null) store.patchBot(bot.id, { needsAttention: null });
  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — box provisioning can take ~90s and must never
  // hang the HTTP request
  if (!isolated) {
    store.patchBot(bot.id, { busy: true, unread: false });
    setTurnPolicy(bot.threadId, {
      autonomy: workspace.autonomy(bot.id).autonomy,
      access: workspace.access(bot.id).access,
      permissions: workspace.permissions(bot.id),
      approvalRules: workspace.approvalRules(bot.id),
    });
    activeCommsDepth.set(bot.id, commsDepth); // multibot (F9): patrz `activeCommsDepth`
    // The peer message this turn reads is no longer "pending": its turn is
    // running now, so a restart from here on is a dead turn, not a lost one.
    // Only OUR debt is cleared — the same room may still owe somebody else.
    for (const entry of peerTurn.get(bot.id) ?? []) {
      if (rooms.get(entry.roomId)?.pendingTo === bot.id) rooms.setPending(entry.roomId, null);
    }
    const origin: TurnOrigin = opts?.origin ?? "user";
    // Whatever a user- or routine-started turn answers, the user is owed the
    // bubble even if a colleague is waiting on the same turn (steering).
    if (origin !== "bot") turnUserText.add(bot.threadId);
    turnOrigin.set(bot.id, origin);
    if (origin === "routine") scheduleStartedPush(bot.id, `rutyna ${opts?.routineName ?? ""} wystartowała`);
    else if (origin === "user") scheduleStartedPush(bot.id, `zaczyna pracę: ${text.slice(0, 80)}`);
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
    // watchdog 70s - jesli brak turn.completed (provider zawiesil sie) zwolnij busy
    armBusyWatchdog(bot.id);
  }

  void (async () => {
    try {
      // Slot na turę. Wolny (flota poniżej OMB_MAX_PARALLEL_TURNS) → rusza od
      // razu, więc dwa boty pracują naprawdę równolegle.
      if (gated) {
        gatedTurnBots.add(bot.id);
        await computerControl.acquireAgent(bot.id);
        broadcast({ kind: "computer-queue", ...computerControl.control() });
      }
      const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
      if (!isolated && cfg.composio?.key && canUseIntegration(bot.threadId, "integrations")) {
        integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
      }
      // multibot (H1/H3): jeden komputer bota, ten sam dla każdego drivera.
      // Nie ma wyboru źródła ani stanu "off" — kontener stoi od utworzenia bota
      // do jego usunięcia, a tura tylko się do niego podłącza. Awaria zostaje
      // awarią (`error`), nigdy cichym zejściem do bota bez komputera.
      // Żaden problem z komputerem nie może wywrócić tury — bez kontenera bot
      // rozmawia dalej, tylko bez narzędzi komputera (ta sama reguła
      // graceful-absence, co przy braku kontenera).
      try {
        if (isolated) throw new Error("group turn has no private computer");
        const computer = canUseIntegration(bot.threadId, "browser")
          ? await ensureComputer()
          : null;
        if (computer) broadcast({ kind: "computer", botId: bot.id, state: computer.state });
        // ponytail: wspólny pulpit nie jest tu rezerwowany na wyłączność —
        // żadne narzędzie komputera i tak nigdy tej dzierżawy nie sprawdzało,
        // a czekanie na nią szeregowało całą flotę. Gdyby dwa boty naprawdę
        // nie mogły klikać naraz, blokada należy do ścieżki narzędzi, nie do
        // startu tury.
        //
        // Narzędzia przeglądarki jechały przez `python -m server.computer_mcp`
        // i zniknęły z silnikiem Hermesa; teraz ten sam zestaw nazw daje
        // `server/computer/mcp.ts` — proxy stdio nad trasą wewnętrzną harnessu.
        // Montujemy je tym samym driverom, co MCP agentów: claude, codex i ACP
        // to jedyne, które `integrations.localComputer` w ogóle czytają, więc
        // reszta dostałaby w prompcie ofertę, której nie umie zamontować.
        if (computer && computer.state !== "error" && instance.adapter.capabilities.agentsMcp === true) {
          integrations.localComputer = localComputerIntegration(bot.id);
        }
      } catch (e) {
        console.warn(`[multibot] computer unavailable for ${bot.id}:`, e instanceof Error ? e.message : e);
      }
      // MultiBot management MCP: same local stdio shape as upstream
      // MultiBot. Mount on EVERY non-isolated turn, peer turns included —
      // a bot answering another bot needs the same tools it always has, or
      // it cannot ask back, pull in a third bot, or finish the job. The
      // conversation is bounded by the room budget, not by a depth filter.
      if (!isolated && instance.adapter.capabilities.agentsMcp === true) {
        integrations.agents = agentsIntegration(bot.id);
      }
      // Every provider that speaks MCP receives the same provider-neutral web
      // MCP.
      if (!isolated && instance.adapter.capabilities.webTools === "mcp" && canUseIntegration(bot.threadId, "browser")) {
        integrations.web = webMcpIntegration();
      }
      if (!isolated && instance.adapter.capabilities.webTools === "native" && canUseIntegration(bot.threadId, "browser")) {
        integrations.webNative = true;
      }
      // @mentions in the user's message (the composer's tagging UI) become
      // an explicit delegation nudge — the agent still does the ask_bot call
      // itself, so the harness stays the single owner of turns/permissions
      const visibleRoster = store.bots.filter((candidate) => candidate.id === bot.id || canBotContact(bot, candidate));
      const groupHere = groupTurn.get(bot.id);
      const tagged = mentionedBots(
        text,
        visibleRoster.filter((b) => b.id !== bot.id),
      );

      // Providers without MCP (currently Codex and API-backed Grok) still
      // get explicit peer delegation. Fetch replies before their turn and
      // attach them to the prompt; native MCP providers keep live tools.
      let taggedReplies = "";
      // Turą peera ta ścieżka NIE biegnie: koperta zawiera "@Nadawca", więc
      // odbiorca odbiłby ją natychmiast z powrotem. Odpowiedź peera idzie
      // przez deliverPeerMessage po zakończeniu tury.
      if (!isolated && opts?.origin !== "bot" && (!integrations.agents || instance.driverKind === "codex") && tagged.length && canUseIntegration(bot.threadId, "delegation")) {
        const replies = await Promise.all(
          tagged.map(async (peer) => ({
            peer,
            // multibot: tura peera idzie na izolowaną nitkę (delegacja nie
            // tworzy pokoju), więc koperta ani praca peera nie trafiają na
            // jego główny kanał; odpowiedź wraca jak dotąd
            reply: await delegatedPeerTurn(bot.id, peer.id, text, commsDepth),
          })),
        );
        taggedReplies = replies
          .map(({ peer, reply }) => `\nPeer ${peer.name} replied:\n${reply || "(no reply)"}`)
          .join("\n");
      }


      await instance.adapter.sendTurn({
        threadId: turnThreadId,
        // multibot: stan floty leci W TREŚCI tury, nie w polu `system` —
        // przeliczany co turę, bo `busy` zmienia się w trakcie pracy floty;
        // zapamiętany raz byłby gorszy niż żaden.
        text: [
          fleetStatusBlock(visibleRoster, bot.id, fleetEnvironmentForBots(fleetEnvironment, visibleRoster)),
          text,
          turnAttachments.length ? `Attached files:\n${turnAttachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}` : "",
        ]
          .filter(Boolean).join("\n\n"),
        attachments: turnAttachments,
        model: turnModel,
        ...(!isolated ? { resumeCursor: bot.resumeCursors[bot.modelSelection.instanceId] } : {}),
        transcript,
        // multibot: `groupTurn` zyje tylko na czas tury grupowej, wiec blok
        // "kto odpowiada" wchodzi do promptu dokladnie na tych turach.
        system: botSystemPrompt(bot, { isolated, integrations, tagged, taggedReplies, workspace, roster: visibleRoster, currentUser: promptUser, timeZone: cfg.timeZone, ...(groupHere ? { group: { name: groupHere.group.name, members: groupHere.members } } : {}) }),
        integrations,
        ...(opts?.reasoning ? { reasoning: opts.reasoning } : {}),
        // multibot: „Fast mode" jest USTAWIENIEM bota (przeżywa restart), nie
        // wyborem na turę jak poziom rozumowania — stąd czytamy je z rekordu.
        ...(bot.fastMode ? { fastMode: true } : {}),
      } as Parameters<typeof instance.adapter.sendTurn>[0] & { reasoning?: ReasoningLevel; fastMode?: boolean });
      if (integrations.computer) startScreenPoller(bot.id);
    } catch (e) {
      releaseTurnSlot(bot.id);
      if (isolated) isolatedTurnBots.delete(turnThreadId);
      const message = e instanceof Error ? e.message : String(e);
      if (!isolated) {
        const failure = store.appendMessage(bot.threadId, {
          role: "bot",
          kind: "activity",
          tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
        });
        broadcast({ kind: "message", threadId: bot.threadId, message: failure });
        store.patchBot(bot.id, { busy: false });
        endTurnPush(bot.id, "failed", message.slice(0, 120));
        clearTurnPolicy(bot.threadId);
        activeCommsDepth.delete(bot.id); // multibot (F9): tura padła — licznik też
        peerTurn.delete(bot.id);
        groupTurn.get(bot.id)?.done("");
        turnAssistantText.delete(turnThreadId);
        turnUsedTool.delete(turnThreadId);
        turnUserText.delete(turnThreadId);
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
        drainQueuedUserMessages(bot.id);
      }
    }
  })();
}

function appendBotEvent(botId: string, event: NonNullable<Message["event"]>) {
  const bot = store.bot(botId);
  if (!bot) return;
  const message = store.appendMessage(bot.threadId, { role: "bot", kind: "event", event });
  broadcast({ kind: "message", threadId: bot.threadId, message });
}

// ── teach-a-task: synteza nagrania ────────────────────────────────────
// Pisanie skilla z listy kroków to zwykła tura tekstowa, więc leci providerem,
// którym bot i tak gada (codex/claude/…). Nagrywarka CDP jechała przez silnik
// Hermesa i zniknęła razem z nim — trasa przyjmuje kroki z dowolnego źródła.
//
// ponytail: jedna izolowana tura, bez narzędzi i bez historii głównego wątku —
// model dostaje kroki i oddaje JSON-a. Pętla „popraw i spróbuj jeszcze raz"
// dopiero, gdyby modele naprawdę nie trafiały w ten kształt.
const teachSynthesisPrompt = (steps: string[], name: string | null) =>
  `A user just demonstrated a task in your browser. Here is the recording, step by step:

${steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}

Write this up as one of your skills${name ? ` named "${name}"` : ""}. Do not call any tools. Answer with a single \`\`\`json fenced block and nothing else:

{"name": "short-kebab-name", "description": "one line saying what the skill does", "instructions": "the SKILL.md body, markdown"}

The instructions must contain:
1. Numbered steps in natural language, in the recorded order. Treat URLs and selectors as hints, not a contract — the page may have changed, so say WHAT to do, not only what to click.
2. A "Before the first run" section: ask the user multiple-choice (A/B/C) clarifying questions and wait for the answer instead of guessing the task's parameters.
3. An "After each run" section: critique your own result and fix this skill straight away if a step failed or turned out to be unnecessary.`;

/** Skill JSON out of a model reply. `null` when the bot answered in prose —
 * the caller turns that into a 502 carrying the reply, because a silent
 * "nothing happened" is what made the old path unreadable.
 *
 * Kandydatów jest kilka i bierzemy PIERWSZEGO, który się parsuje: bloki ``` w
 * kolejności (odpowiedź lubi zacząć się od zdania albo od bloku z przykładem),
 * a na końcu wycinek od pierwszego `{` do ostatniego `}`. Ten ostatni jest tu
 * kluczowy, nie ozdobny: `instructions` to markdown, więc model potrafi wstawić
 * w środek własny płotek ``` — leniwe dopasowanie ucina wtedy JSON w połowie,
 * a wycinek klamrowy łapie całość. */
function parseSkillDraft(reply: string): { name: string; description: string; instructions: string } | null {
  const candidates = [...reply.matchAll(/```[a-z]*[ \t]*\r?\n([\s\S]*?)```/gi)].map((hit) => hit[1]);
  candidates.push(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const name = String(parsed?.name ?? "").trim();
      const instructions = String(parsed?.instructions ?? "").trim();
      if (name && instructions) {
        return { name, description: String(parsed?.description ?? "").trim(), instructions };
      }
    } catch {
      /* następny kandydat */
    }
  }
  return null;
}

// ── config hot-reload ─────────────────────────────────────────────────
function configStatus() {
  const { profile: _profile, ...status } = configStatusFor(null);
  return status;
}

function configStatusFor(actor: IdentityActor | null) {
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    opencode: {
      configured: Boolean(cfg.opencode?.key !== undefined
        ? cfg.opencode.key
        : cfg.instances?.opencodeGo?.environment?.OPENAI_API_KEY),
    },
    composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
    box: { configured: Boolean(cfg.box?.token) },
    // "can this host speak?" — the Read aloud button routes on it
    voice: { configured: Boolean(cfg.voice?.key) },
    // not a secret — the sidebar shows it
    profile: {
      name: actor?.displayName ?? cfg.profile?.name ?? "",
      // ponytail: e-mail wciąż mieszka w config.json — `users.email` dokłada PR 2.
      email: cfg.profile?.email ?? "",
    },
    workspace: {
      id: cfg.workspace?.id ?? "default",
      name: cfg.workspace?.name ?? "MultiBot workspace",
    },
    // multibot: ustawienia aplikacji, nie sekrety — UI je czyta i odsyła bez
    // zmian, więc jadą tu w pełnej postaci. `timeZone` pusty = "wykryj sam";
    // `autoVerify` przez normalizację, żeby UI nigdy nie zobaczyło śmieci
    // z ręcznie edytowanego pliku ani braku pola.
    timeZone: cfg.timeZone ?? "",
    autoVerify: normalizeAutoVerify(cfg.autoVerify),
    // multibot: kolejność sekcji sidebaru — wspólna dla desktopu i telefonu.
    sectionOrder: cfg.sectionOrder ?? [],
    account: actor ? { uid: actor.userId, role: actor.role } : null,
  };
}

function identityActorForRequest(req: IncomingMessage): IdentityActor | null {
  // `mountAuth` rozwiązało aktora raz, na bramce — bez tego każdy odczyt to
  // kolejny UPDATE w SQLite, a filtr `/api/events` robił go PRZY KAŻDEJ RAMCE
  // (i po wygaśnięciu tokenu cicho przestawał cokolwiek dowozić).
  const stashed = requestActor<IdentityActor>(req);
  if (stashed) return stashed;
  const identityActor = identity.actorForRequest(req);
  if (identityActor) return identityActor;
  if (new URL(req.url ?? "/", "http://localhost").pathname === "/api/auth/access-token") {
    const session = req.headers["x-multibot-session"];
    return identity.actorForSessionToken(typeof session === "string" ? session : null);
  }
  return null;
}

const actorForRequest = identityActorForRequest;

function actorMessageFields(actor: IdentityActor | null): Pick<Message, "userId" | "userName"> {
  return actor ? { userId: actor.userId, userName: actor.displayName } : {};
}

function botForReference(id: string): BotRecord | null {
  return store.bot(id) ?? (id.startsWith("mb-") ? store.botByThread(id.slice(3)) : null);
}

function botSetVisible(botIds: string[], actor: IdentityActor | null): boolean {
  const bots = botIds.map(botForReference);
  return bots.every((bot) => canReadBot(bot, actor)) && bots.every((bot, index) =>
    bots.slice(index + 1).every((peer) => canBotContact(bot, peer)),
  );
}

function groupVisible(group: { bot_ids: string[] }, actor: IdentityActor | null): boolean {
  return botSetVisible(group.bot_ids, actor);
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
  if (store.migrateOrphanedSelections(await registry.describe())) {
    for (const bot of store.bots) broadcast({ kind: "bot", bot });
  }
}

// multibot (G3): jobs outlive onboarding panel mounts and persist their output
// across harness restarts. Global events let any open panel update live.
const setupJobs = new SetupJobs(join(DATA_DIR, "setup-jobs.json"), (job) =>
  broadcast({ kind: "setup.job", job }),
);

// multibot: routines for every driver. The selected instance is resolved by
// startTurn at execution time, so changing model never strands a schedule.
// multibot (webhook): `payload` (treść zdarzenia z webhooka) wchodzi do tury
// jako osobny, oznaczony blok — `routineTurnText` jest JEDNYM wspólnym
// miejscem składania dla wszystkich ścieżek (webhook, tick, Run now).
const harnessRoutines = new HarnessRoutines(join(DATA_DIR, "routines.json"), async (routine, payload) => {
  // Rutyna z konkretną datą to przypomnienie: człowiek ma dostać banerkę i push
  // w zaplanowanej chwili, a nie dopiero wtedy, gdy bot skończy myśleć.
  // tytułem banerki jest sama treść przypomnienia — powtórzona w body dałaby
  // „kawa / kawa"; push i tak bierze nazwę bota jako tytuł
  if (oneShotAt(routine.schedule) !== null) notifyUser(routine.botId, routine.name, "", "reminder");
  await startTurn(routine.botId, routineTurnText(routine.name, routine.prompt, payload), { origin: "routine", routineName: routine.name });
});

// ── multibot (webhook): publiczny inbound rutyn harnessu ──────────────
// Surowe body (Buffer) czytamy TU, nie przez `readBody` (JSON.parse) — HMAC
// liczy się nad bajtami wchodzącymi na wejście, a nie nad sparsowanym JSON-em.
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Treść zdarzenia dla tury: JSON sformatowany do czytelnej postaci (model
// dostaje strukturę, nie jedną linię), cokolwiek innego — surowy tekst.
function webhookPayloadText(body: Buffer): string {
  const raw = body.toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
  } catch {
    /* nie-JSON → zwykły tekst */
  }
  return raw;
}

// Rozstrzygnięcie kto bierze /webhooks/<id>: najpierw rutyny harnessu, przy
// braku trafienia false → proxy przekazuje żądanie do silnika (zachowanie
// rutyn silnika bez zmian). Autoryzacją jest HMAC sekretu, NIE token dostępu —
// wyciek adresu nie może dać kontroli nad instancją. Zły i brakujący podpis
// dostają tę samą odpowiedź, żeby nie mówić zgadującemu, co zawiodło.
async function harnessWebhookInbound(req: IncomingMessage, res: ServerResponse, id: string): Promise<boolean> {
  const job = harnessRoutines.webhookFor(id);
  if (!job) return false;
  const body = await readRawBody(req);
  const signature = String(req.headers["x-slafy-signature"] ?? "");
  if (!verifyWebhookSignature(job.webhookSecret!, body, signature)) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  // Fire-and-forget: 200 wraca natychmiast, tura idzie w tle. Błąd tury
  // (zajęty bot, padnięty driver) ląduje w `last_runs`, nie w odpowiedzi.
  void harnessRoutines.fire(job, webhookPayloadText(body)).catch(() => {});
  json(res, 200, { ok: true });
  return true;
}

function routineView(botId: string, routine: HarnessRoutine) {
  const bot = store.bot(botId);
  const driverKind = bot ? registry.get(bot.modelSelection.instanceId)?.driverKind ?? null : null;
  // R1: expose as `next_run_at` — the same JSON key the engine path uses
  // so the UI reads one shape. `nextRunAt` stays the internal TS field name
  // (server/routines.ts); only the wire shape is renamed here.
  const { nextRunAt, ...rest } = routine;
  return {
    ...rest,
    next_run_at: nextRunAt,
    execution: {
      driverKind,
      limitations: driverKind
        ? [
            "The selected command-line tool must stay installed and signed in on the server.",
            "A busy bot is not interrupted; the routine records an error and waits for its next run.",
            "Interactive CLI approvals may wait until a user reconnects.",
          ]
        : [],
    },
  };
}

// multibot (G1): custom-model config stays write-only for API keys. Helpers
// return only display metadata consumed by app settings and model picker.
const RESERVED_INSTANCE_IDS = new Set([
  ...Object.keys(DEFAULT_INSTANCE_CONFIGS),
  ...BUILT_IN_DRIVERS.map((driver) => driver.driverKind),
  "opencodeGo",
  // multibot: `slafy` i `local` to kind oraz id sprzed usunięcia silnika
  // Hermesa. Zostają zarezerwowane, żeby stary wpis w config.json nie zderzył
  // się z nowo zakładanym modelem.
  "slafy",
  "local",
  "__proto__",
  "prototype",
  "constructor",
]);

function customModelsStatus() {
  return Object.entries(cfg.instances ?? {}).flatMap(([id, entry]) =>
    entry.driver === "openaiCompatible" && !RESERVED_INSTANCE_IDS.has(id) && entry.model?.default
      ? [
          {
            id,
            displayName: entry.displayName ?? id,
            baseUrl: entry.model.baseUrl ?? "",
            model: entry.model.default,
            hasKey: Boolean(entry.environment?.OPENAI_API_KEY),
          },
        ]
      : [],
  );
}

// multibot (S3): lokalny endpoint nie ma standardowego pola opisującego
// jakość tool-calling. Sonda sprawdza więc osiągalność i przyjęcie kontraktu
// `tools`; wynik nie udaje gwarancji poprawnego użycia narzędzi przez model.
async function probeCustomModel(id: string) {
  const entry = cfg.instances?.[id];
  const baseUrl = entry?.driver === "openaiCompatible" ? entry.model?.baseUrl?.replace(/\/$/, "") : "";
  if (!baseUrl || !entry?.model?.default) return { reachable: false, tools: "unknown", error: "no such local model" };
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(entry.environment?.OPENAI_API_KEY ? { authorization: `Bearer ${entry.environment.OPENAI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: entry.model.default,
        messages: [{ role: "user", content: "Odpowiedz jednym słowem: OK" }],
        tools: [{ type: "function", function: { name: "multibot_probe", description: "Test kontraktu narzędzi.", parameters: { type: "object", properties: {} } } }],
        tool_choice: "none",
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return {
      reachable: response.ok,
      tools: response.ok ? "accepted" : "rejected",
      status: response.status,
      ...(response.ok ? {} : { error: (await response.text()).slice(0, 160) }),
    };
  } catch (error) {
    return { reachable: false, tools: "unknown", error: String(error).slice(0, 160) };
  }
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function cliToolsStatus() {
  const described = await registry.describe();
  return CLI_TOOLS.map((tool) => {
    const instance = described.find((item) => item.instanceId === tool.id);
    return {
      id: tool.id,
      driverKind: tool.driverKind,
      displayName: instance?.displayName ?? tool.displayName,
      enabled: cfg.instances?.[tool.id]?.enabled !== false,
      detected: instance?.snapshot.state === "available",
      reason: instance?.snapshot.reason,
      version: instance?.snapshot.version ?? undefined,
      authenticated: instance?.snapshot.authenticated,
      installCommand: tool.installStrategy
        ? "Native installer for this device"
        : installCommandText(tool.install),
      loginCommand: tool.loginCommand ?? null,
      loginAvailable: Boolean(tool.login),
      loginMode: tool.loginMode ?? "stdin",
      loginHint: tool.loginHint ?? null,
    };
  });
}

function cliInstallSpec(tool: (typeof CLI_TOOLS)[number]) {
  if (tool.installStrategy) {
      const filename = tool.installStrategy === "claude-native"
        ? "install-claude.mjs"
        : tool.installStrategy === "kimi-native"
          ? "install-kimi.mjs"
          : tool.installStrategy === "opencode-native"
            ? "install-opencode.mjs"
            : "install-codex.mjs";
    const scriptInRepo = join(ROOT, "scripts", filename);
    const script = existsSync(scriptInRepo) ? scriptInRepo : join(ROOT, filename);
    return existsSync(script)
      ? { command: process.execPath, args: [script] }
      : null;
  }
  return tool.install ?? null;
}

// ── HTTP plumbing ─────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  // API data is never part of the PWA app-shell cache.
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}

async function deleteGroupRecord(id: string): Promise<{ found: boolean }> {
  const found = groupStore.delete(id);
  if (!found) return { found: false };
  broadcast({ kind: "group", deleted: id });
  return { found: true };
}

async function deleteBotRecord(bot: BotRecord): Promise<void> {
  await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => {});
  stopScreenPoller(bot.id);
  harnessRoutines.deleteBot(bot.id);
  attachments.deleteBot(bot.id);
  workspace.deleteBot(bot.id);
  store.deleteBot(bot.id);
  for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
    try {
      unlinkSync(join(dir, `${bot.threadId}.ndjson`));
    } catch {}
  }
  broadcast({ kind: "bot.deleted", botId: bot.id, visibility: bot.visibility, ownerId: bot.ownerId, allowedUserIds: bot.allowedUserIds });
}

// multibot: grupa mieszka w harnessie — rozmowa grupowa idzie przez
// deliverPeerMessage/askBotAndWait, a skład i transkrypt trzyma groupStore.
async function createGroupRecord(name: string, memberIds: string[], section?: string): Promise<{ status: number; body: unknown }> {
  const group = groupStore.upsert({ name, bot_ids: memberIds, section });
  broadcast({ kind: "group", group });
  return { status: 201, body: group };
}

// multibot 0.1.46: dodanie bota do istniejącej grupy (drag & drop w sidebarze).
async function addGroupMemberRecord(id: string, botId: string): Promise<{ status: number; body: unknown }> {
  const group = groupStore.get(id);
  const bot = store.bot(botId);
  if (!group || !bot) return { status: 404, body: { error: "no such group or bot" } };
  const memberId = groupMemberId(bot.threadId);
  if (group.bot_ids.includes(memberId)) return { status: 200, body: group };
  const updated = groupStore.upsert({ id: group.id, name: group.name, bot_ids: [...group.bot_ids, memberId] });
  broadcast({ kind: "group", group: updated });
  return { status: 200, body: updated };
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function identityUser(actor: IdentityActor) {
  return { id: actor.userId, username: actor.username, displayName: actor.displayName, role: actor.role, email: actor.email ?? null };
}

function identitySessionBody(session: CreatedSession & { recoveryCode?: string }, includeSessionToken = false) {
  return {
    user: identityUser(session.actor),
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.expiresAt,
    ...(includeSessionToken ? { sessionToken: session.sessionToken } : {}),
    ...(session.recoveryCode ? { recoveryCode: session.recoveryCode } : {}),
  };
}

function identityHandled(res: ServerResponse, status: number, body: unknown): true {
  json(res, status, body);
  return true;
}

/** One bucket for every route that checks the server password, so guessing it
 * through `register` costs the same as guessing it through `join`. */
const SERVER_PASSWORD_BUCKET = "server-password";

function identityRateLimited(req: IncomingMessage, operation: string): boolean {
  const now = Date.now();
  // Sweeping here keeps the map from growing for the lifetime of the process.
  for (const [old, value] of identityAttempts) if (now - value.startedAt >= 60_000) identityAttempts.delete(old);
  // Behind a proxy every socket says 127.0.0.1, which would put the whole
  // internet in one bucket, so the first forwarded hop is the client — but ONLY
  // when the socket peer really is loopback, i.e. there IS a proxy in front. A
  // remote peer that sets its own `x-forwarded-for` would otherwise pick its own
  // bucket every request: an unlimited supply of scrypt guesses at the password.
  const address = rateLimitAddress(req.socket, req.headers["x-forwarded-for"]);
  const key = `${operation}:${address}`;
  const current = identityAttempts.get(key);
  if (!current) {
    identityAttempts.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > 10;
}

async function handleIdentityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  actor: IdentityActor | null,
): Promise<boolean> {
  if (method === "GET" && (path === "/api/public/handshake" || path === "/api/public/server")) {
    // The name stays public: the sign-in header shows it, and 1024 slugs are
    // enumerable anyway. The password is the secret that matters. Odcisk
    // certyfikatu też jest publiczny (klient widzi go w uścisku dłoni) —
    // podajemy go, żeby dało się go porównać z tym z logu i z panelu.
    const info = identity.publicInfo();
    return identityHandled(res, 200, {
      ...info,
      tlsFingerprint: TLS_FINGERPRINT,
      // Przeglądarka na tym urządzeniu nie może wziąć trzech wartości sama:
      // `/api/setup/values` bramkuje token, który leży W TYM pliku, a karty nie
      // czytają plików. Jedyne, co jej pomaga, to ścieżka do otwarcia. Wyłącznie
      // dopóki serwer jest niczyj i wyłącznie z pętli zwrotnej — dalej byłaby to
      // podpowiedź dla obcych, gdzie leży hasło.
      ...(!info.configured && isLoopbackRequest(req) ? { setupPath: identity.setupFilePath() } : {}),
    });
  }
  if (method === "GET" && path === "/api/setup/values") {
    // Reads the password back from setup.json — the only place it exists in the
    // clear, and only while nobody has claimed the server yet. Loopback is not
    // per-app on Android, so the real gate is the setup token FROM that file:
    // whoever can read it (Electron main, the installer, `cat`) can call this,
    // a stray app on the same phone cannot.
    const values = isLoopbackRequest(req) && identity.userCount() === 0
      ? identity.setupValues(req.headers["x-multibot-setup"])
      : null;
    if (!values) return identityHandled(res, 404, { error: "not_found" });
    res.setHeader("cache-control", "no-store");
    const address = primaryAddress(PORT);
    const report = currentReport(PORT);
    return identityHandled(res, 200, {
      ...values,
      address,
      addresses: report.candidates.map((candidate) => candidate.address),
      // Czym ten adres JEST, nie tylko jaki jest. Ekran „postaw serwer" mówi
      // wprost, że działa tylko w tej sieci Wi-Fi, że nikt go nie potwierdził
      // z zewnątrz albo że operator chowa urządzenie za swoim NAT-em — inaczej
      // trzy wartości wyglądają na gotowe, a z drugiego urządzenia nie działają.
      addressKind: report.candidates.find((candidate) => candidate.address === address)?.kind ?? null,
      addressVerified: report.verified,
      portMapping: report.portMapping,
      // Trzecia wartość obok adresu i hasła: pod nią urządzenie dołączające
      // sprawdza, czy rozmawia z TYM serwerem, a nie z kimś po drodze.
      tlsFingerprint: TLS_FINGERPRINT,
    });
  }
  if (method === "POST" && path === "/api/auth/join") {
    if (identityRateLimited(req, SERVER_PASSWORD_BUCKET)) return identityHandled(res, 429, { error: "too many attempts" });
    try {
      const body = await readBody(req);
      return identityHandled(res, 200, await identity.join(body.serverName, body.serverPassword));
    } catch (error) {
      const status = error instanceof IdentityError ? error.status : 400;
      return identityHandled(res, status, { error: error instanceof IdentityError ? error.message : "invalid request" });
    }
  }
  if (method === "POST" && path === "/api/auth/register") {
    if (identityRateLimited(req, "register")) return identityHandled(res, 429, { error: "too many attempts" });
    try {
      const body = await readBody(req);
      // No grant means this call is guessing the server password directly, so
      // it shares the join bucket rather than getting its own budget.
      if (!body.joinGrant && identityRateLimited(req, SERVER_PASSWORD_BUCKET)) {
        return identityHandled(res, 429, { error: "too many attempts" });
      }
      let session = await identity.register({
        username: body.username,
        password: body.password,
        displayName: body.displayName,
        email: body.email,
        joinGrant: body.joinGrant,
        serverName: body.serverName,
        serverPassword: body.serverPassword,
        deviceName: body.deviceName,
      });
      if (session.actor.role === "owner") {
        store.migrateLegacyOwner(session.actor.userId, session.actor.displayName);
        // The pre-0.4.0 install kept one shared e-mail in config.json. It
        // belonged to whoever ran the server, and that is exactly this account.
        // The owner row is already committed, so a malformed legacy address is
        // a warning, never a failed registration.
        try {
          if (!session.actor.email && cfg.profile?.email) {
            session = { ...session, actor: identity.updateProfile(session.actor, session.actor.displayName, cfg.profile.email) };
          }
        } catch (error) {
          console.warn("[multibot] legacy config.json e-mail not carried over to the owner profile:", error);
        }
      }
      res.setHeader("set-cookie", identityCookie(session.sessionToken, isSecureRequest(req)));
      res.setHeader("cache-control", "no-store");
      return identityHandled(res, 201, identitySessionBody(session, req.headers["x-multibot-client"] === "native"));
    } catch (error) {
      const status = error instanceof IdentityError ? error.status : 400;
      return identityHandled(res, status, { error: error instanceof IdentityError ? error.message : "invalid request" });
    }
  }
  if (method === "POST" && path === "/api/auth/login") {
    if (identityRateLimited(req, "login")) return identityHandled(res, 429, { error: "too many attempts" });
    try {
      const body = await readBody(req);
      const session = await identity.login({ username: body.username, password: body.password, joinGrant: body.joinGrant, deviceName: body.deviceName });
      res.setHeader("set-cookie", identityCookie(session.sessionToken, isSecureRequest(req)));
      res.setHeader("cache-control", "no-store");
      return identityHandled(res, 200, identitySessionBody(session, req.headers["x-multibot-client"] === "native"));
    } catch (error) {
      const status = error instanceof IdentityError ? error.status : 400;
      return identityHandled(res, status, { error: error instanceof IdentityError ? error.message : "invalid request" });
    }
  }
  if (method === "POST" && path === "/api/auth/recover") {
    if (identityRateLimited(req, "recover")) return identityHandled(res, 429, { error: "too many attempts" });
    try {
      const body = await readBody(req);
      const session = await identity.recover({ username: body.username, recoveryCode: body.recoveryCode, newPassword: body.newPassword, joinGrant: body.joinGrant, deviceName: body.deviceName });
      res.setHeader("set-cookie", identityCookie(session.sessionToken, isSecureRequest(req)));
      res.setHeader("cache-control", "no-store");
      // `recover` unieważnił WSZYSTKIE sesje tego konta — ich gniazda muszą pójść.
      revokeAuthSessions(req.socket);
      return identityHandled(res, 200, identitySessionBody(session, req.headers["x-multibot-client"] === "native"));
    } catch (error) {
      const status = error instanceof IdentityError ? error.status : 400;
      return identityHandled(res, status, { error: error instanceof IdentityError ? error.message : "invalid request" });
    }
  }
  if (path.startsWith("/api/auth/") || path === "/api/profile" || path.startsWith("/api/server") || path.startsWith("/api/workspace") || path.startsWith("/api/admin/")) {
    if (!actor) return identityHandled(res, 401, { error: "unauthorized" });
    try {
      if (method === "POST" && path === "/api/auth/access-token") {
        return identityHandled(res, 200, identity.issueAccessToken(actor));
      }
      if (method === "POST" && path === "/api/auth/session") {
        if (req.headers["x-multibot-client"] === "native") {
          const session = identity.createSessionForActor(actor, "mobile");
          res.setHeader("set-cookie", identityCookie(session.sessionToken, isSecureRequest(req)));
          return identityHandled(res, 200, identitySessionBody(session, true));
        }
        return identityHandled(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/auth/me") {
        // A signed-in OWNER that got here from a public remote address just
        // proved that address works. Owner only: this rewrites the server-wide
        // address and pushes to the owner's phone, which is not a member's to
        // trigger — and not a public route's either.
        if (actor.role === "owner") noteReachedHost(req, PORT);
        return identityHandled(res, 200, { user: identityUser(actor), server: identity.publicInfo() });
      }
      if (method === "POST" && (path === "/api/auth/logout" || path === "/api/auth/logout-all")) {
        identity.logout(req, path.endsWith("logout-all"));
        res.setHeader("set-cookie", identityCookie("", isSecureRequest(req), true));
        revokeAuthSessions(req.socket);
        return identityHandled(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/auth/sessions") {
        return identityHandled(res, 200, { sessions: identity.listSessions(actor) });
      }
      const sessionPath = path.match(/^\/api\/auth\/sessions\/([^/]+)$/);
      if (method === "DELETE" && sessionPath) {
        return identityHandled(res, identity.revokeSession(actor, decodeURIComponent(sessionPath[1])) ? 200 : 404, { ok: true });
      }
      if (method === "GET" && path === "/api/profile") return identityHandled(res, 200, { user: identityUser(actor) });
      if (method === "PATCH" && path === "/api/profile") {
        const body = await readBody(req);
        return identityHandled(res, 200, { user: identityUser(identity.updateProfile(actor, body.displayName, body.email)) });
      }
      if (method === "GET" && path === "/api/server") {
        const report = currentReport(PORT);
        return identityHandled(res, 200, { ...identity.publicInfo(), publicAddress: report.current ?? identity.publicAddress(), addressVerified: report.verified, tlsFingerprint: TLS_FINGERPRINT });
      }
      if (method === "PATCH" && path === "/api/server") {
        const body = await readBody(req);
        return identityHandled(res, 200, await identity.updateServer(actor, body.name));
      }
      if (method === "POST" && path === "/api/server/password") {
        res.setHeader("cache-control", "no-store");
        return identityHandled(res, 200, { serverPassword: await identity.rotateServerPassword(actor) });
      }
      if (path === "/api/server/address" && (method === "GET" || method === "POST")) {
        if (actor.role !== "owner") return identityHandled(res, 403, { error: "owner access required" });
        if (method === "GET") return identityHandled(res, 200, currentReport(PORT));
        const body = await readBody(req);
        if (body?.refresh === true) return identityHandled(res, 200, await refreshAddress(PORT));
        const pinned = pinAddress(PORT, body?.address);
        return pinned ? identityHandled(res, 200, pinned) : identityHandled(res, 422, { error: "invalid address" });
      }
      if (method === "GET" && path === "/api/server/members") return identityHandled(res, 200, { members: identity.members() });
      // ── owner-only admin surface ──────────────────────────────────────
      // One check for the whole prefix: a member never reaches a handler here,
      // so no future route under /api/admin/ can forget its own gate.
      if (path.startsWith("/api/admin/")) {
        if (actor.role !== "owner") return identityHandled(res, 403, { error: "owner access required" });
        if (method === "GET" && path === "/api/admin/overview") {
          res.setHeader("cache-control", "no-store");
          return identityHandled(res, 200, await adminOverview({ identity, store, server, tlsFingerprint: TLS_FINGERPRINT }));
        }
        const adminUser = path.match(/^\/api\/admin\/users\/([^/]+)$/);
        if (method === "PATCH" && adminUser) {
          const body = await readBody(req);
          const { user, staleSockets } = identity.adminUpdateUser(actor, decodeURIComponent(adminUser[1]), body);
          // Revoking the credential in SQLite is not enough on its own: an SSE
          // stream or a computer socket resolved its actor at upgrade time and
          // would keep the old role — or keep working while disabled — until it
          // happened to close.
          if (staleSockets) revokeAuthSessions(req.socket);
          return identityHandled(res, 200, { user });
        }
        const adminReset = path.match(/^\/api\/admin\/users\/([^/]+)\/reset$/);
        if (method === "POST" && adminReset) {
          res.setHeader("cache-control", "no-store");
          return identityHandled(res, 200, { recoveryCode: identity.resetRecoveryCode(actor, decodeURIComponent(adminReset[1])) });
        }
        // Owner-only means owner-only: an unmatched admin path ends here rather
        // than falling through to a general handler that never saw the prefix.
        return identityHandled(res, 404, { error: `unknown route ${path}` });
      }
      if (method === "GET" && path === "/api/workspace") {
        const info = identity.publicInfo();
        return identityHandled(res, 200, { id: info.serverId, name: info.name, members: identity.members(), currentUser: identityUser(actor) });
      }
      if (method === "GET" && path === "/api/workspace/members") return identityHandled(res, 200, { members: identity.members().map((member) => ({ uid: member.userId, name: member.displayName, username: member.username, role: member.role })) });
    } catch (error) {
      const status = error instanceof IdentityError ? error.status : 400;
      return identityHandled(res, status, { error: error instanceof IdentityError ? error.message : "invalid request" });
    }
  }
  return false;
}

const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  let actor = actorForRequest(req);
  const adminMutation = method !== "GET" && (
    path.startsWith("/api/models/custom/") ||
    path.startsWith("/api/cli-tools/") ||
    path.startsWith("/api/progress/") ||
    path.startsWith("/api/connectors/")
  );
  if (adminMutation && actor?.role !== "owner") return json(res, 403, { error: "owner access required" });
  const langParam = url.searchParams.get("lang");
  if (langParam === "pl" || langParam === "en") uiLang = langParam;
  try {
    const identityRoute = path.startsWith("/api/auth/") || path === "/api/profile" || path.startsWith("/api/server") || path.startsWith("/api/workspace") || path.startsWith("/api/admin/");
    if (isIdentityPublicRoute(method, path) || (actor && identityRoute)) {
      if (await handleIdentityRoute(req, res, path, method, actor)) return;
    }
    // ── internal peer-agent comms (localhost + shared token only) ──────
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (path.startsWith("/api/internal/")) {
      // Te trasy istnieją dla procesów, które harness sam uruchomił na TEJ
      // maszynie. Od 0.4.0 serwer bywa wystawiony do sieci, więc sam token to
      // za mało: pod adresem publicznym tych tras po prostu nie ma.
      if (!isLoopbackRequest(req)) return json(res, 403, { error: "local only" });
      if (req.headers.authorization !== `Bearer ${COMMS_TOKEN}`) {
        return json(res, 401, { error: "unauthorized" });
      }
      // multibot: every computer tool, one route. The MCP proxy is then a table
      // of names and the harness stays the only owner of the browser — the same
      // split the Python `server.computer_mcp` had over the engine's REST API.
      if (method === "POST" && path === "/api/internal/computer/tool") {
        const body = await readBody(req);
        const caller = store.bot(String(body?.self ?? ""));
        if (!caller) return json(res, 404, { error: "no such bot" });
        const name = String(body?.name ?? "");
        // Fail closed, and per TOOL rather than per integration: `computer_exec`
        // is a shell, so it answers to the `terminal` permission and to
        // read-only access — neither of which `canUseIntegration("browser")`
        // looks at. No registered policy = no turn is running: a warm CLI
        // process must not keep a browser and a shell between turns.
        if (!turnPolicy(caller.threadId)) return json(res, 403, { error: "no turn is running for this bot" });
        if (!toolsetAllowed(caller.threadId, computerToolset(name))) {
          return json(res, 403, { error: `this bot may not use ${name} on this turn` });
        }
        try {
          const out = await computerTool(name, (body?.args ?? {}) as Record<string, unknown>);
          return json(res, 200, out as Record<string, unknown>);
        } catch (e) {
          const status = (e as { status?: number }).status ?? 502;
          return json(res, status, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (method === "GET" && path === "/api/internal/environment") {
        const self = url.searchParams.get("self") ?? "";
        const caller = store.bot(self);
        if (!caller) return json(res, 404, { error: "no such bot" });
        const visible = store.bots.filter((candidate) =>
          candidate.id === self || canBotContact(caller, candidate),
        );
        return json(res, 200, { environment: fleetEnvironmentForBots(fleetEnvironment, visible) });
      }
      if (method === "GET" && path === "/api/internal/agents") {
        const self = url.searchParams.get("self");
        const caller = store.bot(self ?? "");
        const bots = store.bots
          .filter((b) => b.id !== self && !b.hidden && canBotContact(caller, b))
          .map((b) => ({
            id: b.id,
            name: b.name,
            model: b.modelSelection.model,
            busy: !!b.busy,
            // multibot (F9): delegacja PO OPISIE. Bez tego pola wołający wybiera
            // adresata wyłącznie po nazwie — a nazwa nie mówi, czym bot się
            // zajmuje. To ta sama persona (`title`/`description` z BotRecord),
            // którą bot dostaje w swoim `system`, więc flota opisuje się floci
            // dokładnie tak, jak opisał ją użytkownik.
            description: [b.title, b.description].filter(Boolean).join(" — "),
          }));
        return json(res, 200, { bots });
      }
      if (method === "POST" && path === "/api/internal/attachments") {
        // multibot: bot→user file sending. The agents MCP `send_file` tool POSTs
        // here; we store the file and hold it for the bot's next chat message.
        const body = await readBody(req);
        const botId = String(body.botId ?? "");
        const bot = store.bot(botId);
        if (!bot) return json(res, 404, { error: "no such bot" });
        // Ścieżka jest drogą główną: bot pisze plik swoim narzędziem i podaje
        // gdzie leży, zamiast przepychać jego bajty base64-em przez własne
        // wyjście — tam ucinały się już przy trzydziestu kilobajtach.
        const buf = body.path
          ? readFileSync(resolveBotFile(String(body.path)))
          : Buffer.from(String(body.content ?? ""), "base64");
        // Przy wysyłce po ścieżce nazwa pliku jest już znana — bot nie musi jej
        // powtarzać, a powtórzona bywała inna niż prawdziwa.
        const fallbackName = body.path ? basename(String(body.path)) : "file";
        const meta = attachments.add(botId, String(body.name ?? fallbackName), String(body.mime ?? "application/octet-stream"), buf);
        const pending = pendingBotAttachments.get(bot.threadId) ?? [];
        pending.push(meta);
        pendingBotAttachments.set(bot.threadId, pending);
        return json(res, 201, meta);
      }
      if (method === "POST" && path === "/api/internal/agent-action") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const action = String(body.action ?? "");
        const caller = store.bot(fromBotId);
        if (!caller) return json(res, 404, { error: "no such caller bot" });
        const access = workspace.access(fromBotId).access;
        const privateBot = caller.visibility === "private";
        const teamActions = new Set(["team.memory.list", "team.memory.graph", "team.memory.markdown.get", "team.memory.add"]);
        if (privateBot && teamActions.has(action)) return json(res, 404, { error: "team scope unavailable to private bot" });
        const readOnlyActions = new Set(["profile.get", "memory.list", "memory.graph", "memory.markdown.get", "team.memory.list", "team.memory.graph", "team.memory.markdown.get", "mail.inbox", "skills.list", "routines.list", "groups.list", "device.info", "file.read"]);
        if (access === "read-only" && !readOnlyActions.has(action)) return json(res, 403, { error: "read-only access" });
        const requireFull = () => {
          if (access !== "full") throw Object.assign(new Error("Full Access required for this action"), { status: 403 });
        };
        // multibot: rutyny CUDZEGO bota. `bot_id` jest opcjonalne (brak = swoje),
        // a cudzy bot musi być widoczny dla wołającego — i, gdy wołający jest
        // szefem sztabu, siedzieć w jego sekcji. Te same dwie bramki, którymi
        // chodzi `agent.update`, bo to ta sama władza nad cudzym botem.
        const routineOwner = (): string => {
          const wanted = String(body.bot_id ?? body.botId ?? "").trim();
          if (!wanted || wanted === fromBotId) return fromBotId;
          const target = store.bot(wanted);
          if (!target || !canBotContact(caller, target)) throw Object.assign(new Error("no such target bot"), { status: 404 });
          if (caller.chiefOfStaff && (target.section?.trim() ?? "") !== (caller.section?.trim() ?? "")) {
            throw Object.assign(new Error("chief delegation is limited to its section"), { status: 403 });
          }
          return target.id;
        };
        const bot = () => store.bot(fromBotId)!;
        switch (action) {
          case "profile.get": return json(res, 200, bot());
          case "profile.update": {
            requireFull();
            const patch: Record<string, unknown> = {};
            for (const key of ["name", "title", "description", "notifications", "color", "mascotExpression", "mascotShape", "modelSelection"] as const) {
              if (body[key] !== undefined) patch[key] = body[key];
            }
            // Ta sama lista, co w `managedBotPatch` — inaczej bot ustawia sobie
            // ksztalt spoza zestawu i wlasna maskotka rysuje sie na czarno.
            if (patch.mascotShape !== undefined && !BOT_SHAPES.includes(patch.mascotShape as never)) {
              return json(res, 422, { error: `unknown mascotShape: must be one of ${BOT_SHAPES.join(", ")}` });
            }
            const previous = store.bot(fromBotId);
            // multibot: jawnie kopiujemy nazwę przed patchem — patchBot mutuje
            // rekord w miejscu, więc `previous.name` po patchu to już NOWA nazwa.
            const previousName = previous?.name;
            const updated = store.patchBot(fromBotId, patch);
            broadcast({ kind: "bot", bot: updated });
            if (updated && typeof patch.name === "string" && previousName !== updated.name) {
              appendBotEvent(fromBotId, { type: "renamed", value: updated.name });
            }
            return json(res, 200, updated);
          }
          // multibot: bot pyta właściciela i CZEKA na odpowiedź. Karta jest ta
          // sama, którą buduje `request.opened`, więc UI nie wie o różnicy.
          case "user.ask": {
            const question = String(body.question ?? "").trim();
            if (!question) return json(res, 422, { error: "question required" });
            const choices = Array.isArray(body.choices)
              ? body.choices.map((choice: unknown) => String(choice).trim()).filter(Boolean).slice(0, 5)
              : [];
            const answer = await askOwnerAndWait(caller.threadId, {
              title: t("Bot ma pytanie", "Your bot has a question"),
              subtitle: question,
              options: choices,
            });
            return json(res, 200, { answer });
          }
          // multibot: bot oddaje komputer człowiekowi — logowanie, 2FA, captcha.
          // Ta sama karta i ten sam mechanizm czekania co `user.ask`; różni się
          // tylko `kind`, po którym UI rysuje przejmij / gotowe / pomiń.
          // Każdy bot ma własny hosted computer (H1), więc nie ma czego bramkować.
          case "computer.handover": {
            const reason = String(body.reason ?? "").trim();
            if (!reason) return json(res, 422, { error: "reason required" });
            const answer = await askOwnerAndWait(caller.threadId, {
              kind: "computer-handoff",
              title: t("Komputer", "Computer"),
              subtitle: reason,
              options: [],
            });
            return json(res, 200, { answer });
          }
          case "credential.request": {
            requireFull();
            const target = body.target;
            if (!isCredentialTargetId(target)) return json(res, 422, { error: "unsupported credential target" });
            const answer = await askCredentialAndWait(caller, target);
            return json(res, 200, { answer });
          }
          // multibot: przypomnienie to rutyna z jednorazową datą (ISO), nie cron
          // raz na rok. Prompt każe botowi POWIEDZIEĆ o tym w chwili odpalenia.
          case "reminders.create": {
            requireFull();
            const text = String(body.text ?? "").trim().slice(0, 100);
            const at = String(body.at ?? "").trim();
            if (!text || !at) return json(res, 422, { error: "text and at required" });
            try {
              const routine = harnessRoutines.create(fromBotId, {
                name: text,
                prompt: `Reminder for the user: ${text}. Tell them now, in one short line, and do the task if it is something you can do yourself.`,
                schedule: at,
              });
              appendBotEvent(fromBotId, { type: "reminder-created", value: text });
              broadcast({ kind: "workspace", botId: fromBotId, resource: "routines" });
              return json(res, 201, routineView(fromBotId, routine));
            } catch (error) {
              return json(res, 422, { error: error instanceof Error ? error.message : String(error) });
            }
          }
          // multibot: bot ma coś do POWIEDZENIA, nie o co zapytać — banerka i
          // push zamiast karty, która wstrzymuje turę na cztery minuty.
          case "user.notify": {
            const title = String(body.title ?? "").trim().slice(0, 120);
            const text = String(body.body ?? "").trim().slice(0, 400);
            if (!title) return json(res, 422, { error: "title required" });
            notifyUser(fromBotId, title, text, "notify");
            const updated = store.patchBot(fromBotId, { unread: true });
            broadcast({ kind: "bot", bot: updated });
            return json(res, 200, { ok: true });
          }
          // multibot: brak konektora to nie jest akapit prozy „wejdź w Plugins".
          // Karta prowadzi w konkretne miejsce i NIE blokuje tury — bot kończy,
          // a następna tura widzi konektor w `connectionsBlock`.
          case "connection.request": {
            const asked = String(body.connector ?? "").trim().slice(0, 40).toLowerCase();
            // An app name is a Composio toolkit: the card leads to the same
            // panel, with the app the bot actually asked for on it.
            const toolkit = !isConnectorTarget(asked) && TOOLKIT_SLUG.test(asked) ? toolkitLabel(asked) : null;
            const connector: ConnectorTarget = isConnectorTarget(asked) ? asked : "composio";
            if (!isConnectorTarget(asked) && !toolkit) return json(res, 422, { error: "unknown connector" });
            const label = CONNECTION_TARGETS[connector];
            const why = String(body.why ?? "").trim().slice(0, 300);
            const message = store.appendMessage(caller.threadId, {
              role: "bot",
              kind: "options",
              card: {
                kind: "connect",
                connector,
                title: toolkit
                  ? t(`Podłącz ${toolkit} (${label.pl})`, `Connect ${toolkit} (${label.en})`)
                  : t(`Podłącz ${label.pl}`, `Connect ${label.en}`),
                subtitle: why,
                options: [],
              },
            });
            broadcast({ kind: "message", threadId: caller.threadId, message });
            return json(res, 200, { ok: true, connector, ...(toolkit ? { toolkit: asked.toLowerCase() } : {}) });
          }
          case "memory.list": return json(res, 200, workspace.facts(fromBotId, String(body.query ?? "")));
          case "memory.graph": return json(res, 200, workspace.graph(fromBotId));
          case "memory.markdown.get": return json(res, 200, workspace.markdown(fromBotId));
          case "mail.inbox": return json(res, 200, {
            messages: unreadRoomMessages(fromBotId).map((entry) => ({
              roomId: entry.room.id,
              room: entry.room.name,
              from: store.bot(entry.from)?.name ?? entry.from,
              text: entry.text,
              at: entry.at,
            })),
          });
          case "mail.send": {
            const sent = await deliverPeerMessage(fromBotId, String(body.toBotId ?? ""), String(body.message ?? ""));
            if (sent.status === "refused") return json(res, 200, { error: sent.note });
            return json(res, 202, {
              accepted: true,
              roomId: sent.roomId,
              delivery: sent.status,
              botName: store.bot(String(body.toBotId ?? ""))?.name,
            });
          }
          case "memory.add": { requireFull(); const fact = workspace.addFact(fromBotId, body); broadcast({ kind: "workspace", botId: fromBotId, resource: "memory" }); return json(res, 201, fact); }
          case "memory.markdown.set": { requireFull(); const markdown = workspace.putMarkdown(fromBotId, body.content); broadcast({ kind: "workspace", botId: fromBotId, resource: "memory" }); return json(res, 200, markdown); }
          case "team.memory.list": return json(res, 200, workspace.teamFacts(String(body.query ?? "")));
          case "team.memory.graph": return json(res, 200, { facts: workspace.teamFacts(String(body.query ?? "")), markdown: workspace.teamMarkdown() });
          case "team.memory.markdown.get": return json(res, 200, workspace.teamMarkdown());
          case "team.memory.add": { requireFull(); const fact = workspace.addTeamFact(body); broadcast({ kind: "workspace", resource: "team-memory" }); return json(res, 201, fact); }
          case "skills.list": return json(res, 200, workspace.skills(fromBotId));
          case "skills.create": { requireFull(); const skill = workspace.addSkill(fromBotId, body); appendBotEvent(fromBotId, { type: "skill-created", value: skill.name }); broadcast({ kind: "workspace", botId: fromBotId, resource: "skills" }); return json(res, 201, skill); }
          case "skills.update": { requireFull(); const skill = workspace.patchSkill(fromBotId, String(body.name), body); broadcast({ kind: "workspace", botId: fromBotId, resource: "skills" }); return json(res, 200, skill ?? { error: "no such skill" }); }
          case "skills.delete": { requireFull(); const ok = workspace.deleteSkill(fromBotId, String(body.name)); broadcast({ kind: "workspace", botId: fromBotId, resource: "skills" }); return json(res, 200, { ok }); }
          case "routines.list": return json(res, 200, harnessRoutines.list(routineOwner()).map((routine) => routineView(routineOwner(), routine)));
          case "routines.create": { requireFull(); const owner = routineOwner(); const routine = harnessRoutines.create(owner, body); appendBotEvent(owner, { type: "routine-created", value: routine.name }); broadcast({ kind: "workspace", botId: owner, resource: "routines" }); return json(res, 201, routineView(owner, routine)); }
          // multibot: bot umiał TYLKO założyć rutynę — nie umiał jej wyłączyć
          // ani przestawić, więc po zmianie planu na serwerze zostawały dwie
          // działające naraz. Ta sama ścieżka co PATCH /api/bots/:id/routines/:rid.
          case "routines.update": {
            requireFull();
            const owner = routineOwner();
            const patch: Partial<Pick<HarnessRoutine, "name" | "prompt" | "schedule" | "enabled">> = {};
            for (const key of ["name", "prompt", "schedule", "enabled"] as const) {
              if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
            }
            const routine = harnessRoutines.update(owner, String(body.id), patch);
            if (!routine) return json(res, 404, { error: "no such routine" });
            broadcast({ kind: "workspace", botId: owner, resource: "routines" });
            return json(res, 200, routineView(owner, routine));
          }
          case "routines.run": { requireFull(); const owner = routineOwner(); const routine = await harnessRoutines.runNow(owner, String(body.id)); broadcast({ kind: "workspace", botId: owner, resource: "routines" }); return json(res, 200, routine ? routineView(owner, routine) : { error: "no such routine" }); }
          case "routines.delete": { requireFull(); const owner = routineOwner(); const ok = harnessRoutines.delete(owner, String(body.id)); broadcast({ kind: "workspace", botId: owner, resource: "routines" }); return json(res, 200, { ok }); }
          case "agent.create": {
            requireFull();
            let profile: Partial<BotRecord>;
            try {
              profile = managedBotPatch(body, { temporary: true });
            } catch (error) {
              return json(res, 422, { error: error instanceof Error ? error.message : String(error) });
            }
            if (!profile.name) return json(res, 422, { error: "name required" });
            const created = store.createBot({ temporary: profile.temporary === true });
            const selection = profile.modelSelection ?? bootSelection;
            const creator = store.bot(fromBotId);
            const rawIntent = String(profile.description ?? profile.title ?? profile.name).trim().slice(0, 2000);
            const creationContext = rawIntent
              ? `Stworzony przez bota ${creator?.name ?? fromBotId} (id: ${fromBotId}) do zadania: ${rawIntent}. Twoim pierwszym zadaniem jest to zadanie — zacznij od razu, nie pytaj kim jesteś.`
              : `Stworzony przez bota ${creator?.name ?? fromBotId} (id: ${fromBotId}). Sprawdź swój profil (name/title/description) i wiadomości od botów (read_bot_mail) — to jest Twoje zadanie. Zacznij od razu, nie pytaj kim jesteś.`;
            const updated = store.patchBot(created.id, { ...profile, modelSelection: selection, ownerId: caller.ownerId, visibility: caller.visibility === "private" ? "private" : "team", ...(caller.chiefOfStaff ? { section: caller.section } : {}), createdByBotId: fromBotId, creationContext });
            console.log(`[multibot] bot ${created.id} (${profile.name}) created by bot ${fromBotId} (${creator?.name ?? "unknown"}) — intent: ${rawIntent.slice(0, 120)}`);
            if (access === "full") workspace.setAccess(created.id, "full");
            broadcast({ kind: "bot", bot: updated });
            return json(res, 201, updated);
          }
          case "agent.update": {
            requireFull();
            const target = store.bot(String(body.bot_id ?? body.botId ?? ""));
            if (!target) return json(res, 404, { error: "no such target bot" });
            if (!canBotContact(caller, target)) return json(res, 404, { error: "no such target bot" });
            if (caller.chiefOfStaff && (target.section?.trim() ?? "") !== (caller.section?.trim() ?? "")) return json(res, 403, { error: "chief delegation is limited to its section" });
            let patch: Partial<BotRecord>;
            try {
              patch = managedBotPatch(body.patch ?? body);
            } catch (error) {
              return json(res, 422, { error: error instanceof Error ? error.message : String(error) });
            }
            if (!Object.keys(patch).length) return json(res, 422, { error: "no editable fields supplied" });
            const previousName = target.name;
            const updated = store.patchBot(target.id, patch);
            if (typeof patch.name === "string" && previousName !== patch.name) appendBotEvent(target.id, { type: "renamed", value: patch.name });
            broadcast({ kind: "bot", bot: updated });
            return json(res, 200, updated);
          }
          case "agent.get": {
            const target = store.bot(String(body.bot_id ?? body.botId ?? ""));
            if (!target || !canBotContact(caller, target)) return json(res, 404, { error: "no such target bot" });
            return json(res, 200, target);
          }
          case "agent.delete": {
            requireFull();
            const target = store.bot(String(body.bot_id ?? body.botId ?? ""));
            if (!target || !canBotContact(caller, target)) return json(res, 404, { error: "no such target bot" });
            if (target.id === fromBotId) return json(res, 403, { error: "a bot cannot delete itself" });
            if (caller.chiefOfStaff && (target.section?.trim() ?? "") !== (caller.section?.trim() ?? "")) return json(res, 403, { error: "chief delegation is limited to its section" });
            await deleteBotRecord(target);
            return json(res, 200, { ok: true });
          }
          case "groups.list": {
            return json(res, 200, groupStore.list().filter((group) => group.bot_ids.every((id) => canBotContact(caller, store.bot(id)))));
          }
          case "groups.delete": {
            requireFull();
            const id = String(body.groupId ?? "");
            const group = groupStore.get(id);
            if (!group || !group.bot_ids.every((botId) => canBotContact(caller, store.bot(botId)))) return json(res, 404, { error: "no such group" });
            const removed = await deleteGroupRecord(id);
            return removed.found
              ? json(res, 200, { ok: true })
              : json(res, 404, { error: "no such group" });
          }
          case "device.info": return json(res, 200, await deviceInfo());
          case "groups.create": {
            requireFull();
            const botIds: string[] = Array.isArray(body.bot_ids) ? (body.bot_ids as unknown[]).map(String) : [];
            if (botIds.some((id) => !canBotContact(caller, store.bot(id)))) return json(res, 404, { error: "no such target bot" });
            const memberIds = botIds.map((id) => groupMemberId(store.bot(id)?.threadId ?? id));
            const result = await createGroupRecord(String(body.name ?? "Group"), memberIds);
            return json(res, result.status, result.body);
          }
          // multibot: grupa to jeden pokój i jeden budżet. Wiadomość idzie do
          // botów wymienionych po @nazwie, a bez wzmianki do wszystkich —
          // każdy dostaje ZWYKŁĄ turę na swoim wątku i odpowiada we własnym
          // czasie, więc odpowiedź HTTP wraca od razu (202), nie po sumie tur.
          case "groups.send": {
            requireFull();
            const group = groupStore.get(String(body.groupId));
            if (!group || !group.bot_ids.every((botId) => canBotContact(caller, store.bot(botId)))) return json(res, 404, { error: "no such group" });
            const message = String(body.message ?? "").trim();
            if (!message) return json(res, 422, { error: "message required" });
            const groupBots = group.bot_ids
              .map((memberId) => store.botByThread(threadIdOfGroupMember(memberId) ?? ""))
              .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot) && bot?.id !== fromBotId);
            const mentioned = mentionedBots(message, groupBots);
            const targets = mentioned.length ? mentioned : groupBots;
            if (!targets.length) return json(res, 422, { error: "the group has nobody else to talk to" });
            const room =
              rooms.forGroup(group.id) ??
              rooms.create({
                task: message.slice(0, 200),
                bot_ids: [fromBotId],
                ownerThread: caller.threadId,
                ownerBotId: fromBotId,
                groupId: group.id,
              });
            const sent = [];
            for (const target of targets) sent.push(await deliverPeerMessage(fromBotId, target.id, message, room.id));
            const refused = sent.find((one) => one.status === "refused");
            // The group log records what was actually delivered: appending
            // before the ACL check wrote refused messages into the room's
            // history as if they had been sent.
            if (sent.some((one) => one.status !== "refused")) groupStore.append(group.id, { from: fromBotId, text: message });
            return json(res, 202, {
              accepted: true,
              roomId: room.id,
              targets: targets.map((bot) => bot.id),
              ...(refused ? { error: refused.note } : {}),
            });
          }
          // multibot: bot opens a durable collaboration room with another bot
          // to work on a task TOGETHER (read-only for the user). The first
          // message is delivered right away; the room's report lands in the
          // caller's chat when the conversation settles.
          case "collab.start": {
            const target = store.bot(String(body.bot_id ?? ""));
            if (!target || !canBotContact(caller, target)) return json(res, 404, { error: "no such target bot" });
            const task = String(body.task ?? "").trim();
            if (!task) return json(res, 422, { error: "task required" });
            const started = await deliverPeerMessage(fromBotId, target.id, task);
            if (started.status === "refused") return json(res, 200, { error: started.note });
            return json(res, 201, { room: started.roomId ? rooms.get(started.roomId) : null });
          }
          case "file.read": {
            const file = resolve(String(body.path ?? ""));
            if (access !== "full" && file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) {
              return json(res, 403, { error: "read-only access is limited to current workspace" });
            }
            return json(res, 200, { path: file, content: readFileSync(file, "utf8") });
          }
          case "file.write": {
            requireFull();
            const file = resolve(String(body.path ?? ""));
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, String(body.content ?? ""));
            return json(res, 200, { path: file, ok: true });
          }
          case "terminal.run": {
            requireFull();
            const command = String(body.command ?? "").trim();
            const args = Array.isArray(body.args) ? body.args.map(String) : [];
            if (!command) return json(res, 422, { error: "command required" });
            const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => execFile(command, args, { cwd: String(body.cwd ?? ROOT), timeout: 120_000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => resolveRun({ code: error ? (error as any).code ?? 1 : 0, stdout, stderr })));
            return json(res, 200, result);
          }
          default: return json(res, 404, { error: `unknown agent action: ${action}` });
        }
      }
      // multibot: ask_bot NIE czeka. Wiadomość do kolegi to jego prawdziwa
      // tura, a odpowiedź wraca osobną turą do wołającego — wołający kończy
      // swoją i nie trzyma otwartego HTTP przez cudzą pracę.
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
        const sent = await deliverPeerMessage(fromBotId, toBotId, message);
        if (sent.status === "refused") return json(res, 200, { error: sent.note });
        return json(res, 200, { delivered: true, roomId: sent.roomId, botName: store.bot(toBotId)?.name });
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }

    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      const lang = url.searchParams.get("lang");
      if (lang === "pl" || lang === "en") uiLang = lang;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      res.write(`data: ${JSON.stringify({
        kind: "environment.snapshot",
        environment: fleetEnvironmentForActor(actor),
        sequence: ++eventSequence,
      })}\n\n`);
      const client = { res, actor: actorForRequest(req) };
      sseClients.add(client);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {}
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(client);
      });
      return;
    }

    // One server = one workspace. Members share team-visible bots and sections;
    // private bots are filtered by the access gate below.
    const botPath = path.match(/^\/api\/bots\/([^/]+)/);
    if (botPath && !canReadBot(store.bot(decodeURIComponent(botPath[1])), actor)) {
      return json(res, 404, { error: "no such bot" });
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      return json(res, 200, {
        bots: store.bots
          .filter((b) => canReadBot(b, actor))
          .map((b) => ({ ...b, messages: chatMessages(b.threadId) })),
      });
    }
    if (method === "GET" && path === "/api/environment") {
      return json(res, 200, { environment: fleetEnvironmentForActor(actor) });
    }
    let m: RegExpMatchArray | null;
    // multibot: durable group rooms — the harness owns roster, membership and
    // transcript, so groups survive reload/restart.
    if (method === "GET" && path === "/api/groups") {
      return json(res, 200, groupStore.list().filter((group) => groupVisible(group, actor)));
    }
    if (method === "POST" && path === "/api/groups") {
      const body = await readBody(req);
      const name = String(body.name ?? "Group").trim();
      const rawIds: string[] = Array.isArray(body.bot_ids) ? (body.bot_ids as unknown[]).map(String) : [];
      const botIds = rawIds.map((id) => store.bot(id)?.id ?? (id.startsWith("mb-") ? store.botByThread(id.slice(3))?.id : undefined)).filter((id): id is string => !!id);
      if (!name || !botIds.length) return json(res, 422, { error: "group needs at least one bot" });
      if (!botSetVisible(botIds, actor)) return json(res, 404, { error: "no such bot" });
      try {
        const memberIds = botIds.map((id) => groupMemberId(store.bot(id)!.threadId));
        // multibot: grupa mieszka w sekcji tak samo jak bot — osobnej sekcji
        // „GRUPY" już nie ma, więc nazwa przychodzi z formularza tworzenia.
        const section = typeof body.section === "string" ? body.section.trim().slice(0, 60) : "";
        const result = await createGroupRecord(name, memberIds, section || undefined);
        return json(res, result.status, result.body);
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/members$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const group = groupStore.get(m[1]);
      if (!group || !groupVisible(group, actor)) return json(res, 404, { error: "no such group" });
      const botId = String(body.botId ?? "");
      const bot = botForReference(botId);
      if (!bot || !canReadBot(bot, actor)) return json(res, 404, { error: "no such bot" });
      if (!group.bot_ids.every((id) => canBotContact(bot, botForReference(id)))) return json(res, 404, { error: "no such bot" });
      const result = await addGroupMemberRecord(m[1], bot.id);
      return json(res, result.status, result.body);
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && (method === "DELETE" || method === "PATCH")) {
      const group = groupStore.get(m[1]);
      if (!group || !groupVisible(group, actor)) return json(res, 404, { error: "no such group" });
    }
    if (m && method === "GET") {
      const group = groupStore.get(m[1]);
      return group && groupVisible(group, actor) ? json(res, 200, group) : json(res, 404, { error: "no such group" });
    }
    if (m && method === "DELETE") {
      const removed = await deleteGroupRecord(m[1]);
      return removed.found
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such group" });
    }
    // multibot: zmiana nazwy grupy (port z OpenMausBot #343) — harnessowy
    // zapis jest źródłem dla UI, silnik dostaje PATCH best-effort.
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const hasName = typeof body.name === "string";
      // multibot: sekcja sidebaru jest wyłącznie harnessowa — silnik jej nie
      // zna, więc przeniesienie grupy do innej sekcji nie rusza go wcale.
      const hasSection = typeof body.section === "string";
      const name = hasName ? (body.name as string).trim() : "";
      if (hasName && !name) return json(res, 400, { error: "room name must be a non-empty string" });
      if (name.length > 100) return json(res, 400, { error: "room name must be at most 100 characters" });
      if (!hasName && !hasSection) return json(res, 400, { error: "room name must be a non-empty string" });
      let group = hasName ? groupStore.rename(m[1], name) : groupStore.get(m[1]);
      if (group && hasSection) {
        group = groupStore.upsert({
          id: group.id,
          name: group.name,
          bot_ids: group.bot_ids,
          section: (body.section as string).trim().slice(0, 60),
        });
      }
      if (!group) return json(res, 404, { error: "no such group" });
      return json(res, 200, { ok: true, group });
    }
    // multibot: mixed-provider group rooms. The harness owns membership and
    // turns, so Claude/Codex/ACP bots each answer through their own provider.
    m = path.match(/^\/api\/groups\/([\w-]+)\/chat$/);
    if (m && method === "POST") {
      const gid = m[1];
      const body = await readBody(req);
      const message = String(body.message ?? "").trim();
      if (!message) return json(res, 422, { error: "message required" });
      try {
        // multibot: skład grupy bierzemy z trwałego zapisu harnessu — to ta sama
        // lista, którą pokazuje GET /api/groups, więc każda grupa widoczna w UI
        // da się otworzyć.
        const group: { bot_ids?: unknown[]; name?: unknown } | null = groupStore.get(gid);
        if (!group) return json(res, 404, { error: "no such group" });
        const durable = groupStore.get(gid) ?? groupStore.upsert({ id: gid, name: String(group.name ?? "Group"), bot_ids: (group.bot_ids ?? []).map(String) });
        if (!groupVisible(durable, actor)) return json(res, 404, { error: "no such group" });
        const roster = (group.bot_ids ?? [])
          .map((rawId) => store.botByThread(threadIdOfGroupMember(String(rawId)) ?? String(rawId)))
          .filter((bot): bot is BotRecord => Boolean(bot))
          // Stable order, chief of staff first: someone has to read the message
          // before the others, and that is the job the chief already has.
          .sort((a, b) => Number(Boolean(b.chiefOfStaff)) - Number(Boolean(a.chiefOfStaff)));
        if (!roster.length) return json(res, 422, { error: "the group has no bots" });
        groupStore.append(gid, { from: "you", text: message });
        // @mention limits the message to those members; @everyone (or no
        // mention at all) is the whole group. Order stays roster order so the
        // chief of staff, or whoever the user put first, answers first.
        const everyone = /(^|\s)@everyone\b/i.test(message);
        const mentioned = everyone ? [] : mentionedBots(message, roster);
        const targets = mentioned.length ? roster.filter((bot) => mentioned.includes(bot)) : roster;
        // One room per group, so a group keeps a single ledger and a single
        // budget. A spent budget rotates the room instead of killing the chat.
        let room = rooms.forGroup(gid);
        if (room && budgetLeft(room, collabMaxMessages()) <= 0) {
          closeRoom(room.id, "done", "");
          room = null;
        }
        room ??= rooms.create({
          task: durable.name,
          bot_ids: roster.map((bot) => bot.id),
          ownerThread: roster[0].threadId,
          ownerBotId: roster[0].id,
          groupId: gid,
        });
        for (const bot of roster) rooms.addBot(room.id, bot.id);
        rooms.append(room.id, ROOM_USER_SENDER, message);
        broadcast({ kind: "room", room: rooms.get(room.id) });
        const turns = await runGroupChat({ id: gid, name: durable.name }, room, roster, targets);
        for (const t of turns) groupStore.append(gid, { from: t.bot_id, text: t.reply });
        const current = groupStore.get(gid);
        if (current) broadcast({ kind: "group", group: current });
        return json(res, 200, { turns, owner: turns[0]?.bot_id ?? null, roomId: room.id, messages: current?.messages ?? [] });
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    // ── durable collaboration rooms (bot-to-bot tasks) ──
    if (method === "GET" && path === "/api/rooms") {
      return json(res, 200, { rooms: rooms.list().filter((room) => botSetVisible(room.bot_ids, actor)), budget: collabMaxMessages() });
    }
    if (method === "POST" && path === "/api/rooms") {
      const body = await readBody(req);
      const task = String(body.task ?? "").trim();
      const botIds: string[] = Array.isArray(body.bot_ids) ? (body.bot_ids as unknown[]).map(String) : [];
      if (!task || !botIds.length) return json(res, 422, { error: "task and bot_ids required" });
      if (!botSetVisible(botIds, actor)) return json(res, 404, { error: "no such bot" });
      const owner = store.bot(botIds[0])!;
      const room = rooms.create({ task, bot_ids: botIds, ownerThread: owner.threadId, ownerBotId: botIds[0] });
      // No chip here for the normal case: `deliverPeerMessage` posts one
      // "X texted Y" per recipient, which is more precise and is the only chip
      // for a room opened straight from a bot tool. A room with nobody to
      // write to gets the plain room pill, or it has no entry point at all.
      if (botIds.length < 2) postRoomChip(botIds[0], room);
      // The first bot hands the task to the others; from there the room is
      // just their conversation, one real turn per message.
      for (const peerId of botIds.slice(1)) void deliverPeerMessage(botIds[0], peerId, task, room.id);
      return json(res, 201, room);
    }
    m = path.match(/^\/api\/rooms\/([\w-]+)$/);
    if (m && method === "GET") {
      const room = rooms.get(m[1]);
      return room && botSetVisible(room.bot_ids, actor)
        ? json(res, 200, room)
        : json(res, 404, { error: "no such room" });
    }
    if (method === "POST" && path === "/api/bots") {
      const body = await readBody(req);
      const visibility = body.visibility === undefined ? "team" : body.visibility;
      if (visibility !== "team" && visibility !== "private") return json(res, 422, { error: "visibility must be team or private" });
      const bot = store.createBot();
      // bootSelection was resolved once at startup; rescanning every provider
      // here made the first screen wait on CLI processes.
      store.patchBot(bot.id, { modelSelection: bootSelection, ownerId: actor?.userId, visibility });
      // multibot: nowy bot odzywa się PIERWSZY i mówi, co naprawdę potrafi
      // TERAZ. Rozgrzewka CLI nic nie mówiła użytkownikowi (patrzył w pusty
      // ekran), a bot dowiadywał się o swoich brakach dopiero, gdy pierwsze
      // zadanie się o nie rozbiło. Tura rozgrzewa proces przy okazji.
      if (onboardingTurnEnabled()) {
        void startTurn(bot.id, ONBOARDING_FIRST_TURN, { userMessagePosted: true, origin: "bot" }).catch((error) =>
          console.warn(`[multibot] onboarding turn failed for ${bot.id}:`, error instanceof Error ? error.message : error),
        );
      }
      return json(res, 201, { bot: { ...store.bot(bot.id)!, messages: chatMessages(bot.threadId) } });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/sharing$/);
    if (m) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (method === "GET") {
        return json(res, 200, {
          visibility: bot.visibility === "private" ? "private" : "team",
          ownerId: bot.ownerId ?? null,
        });
      }
      if (method === "PATCH") {
        if (!canManageBot(bot, actor)) return json(res, 403, { error: "bot owner access required" });
        const body = await readBody(req);
        const visibility = body.visibility === undefined ? (bot.visibility ?? "team") : body.visibility;
        if (visibility !== "team" && visibility !== "private") {
          return json(res, 422, { error: "visibility must be team or private" });
        }
        const updated = store.patchBot(bot.id, {
          visibility,
          ownerId: bot.ownerId ?? actor?.userId,
          allowedUserIds: [],
        });
        broadcast({ kind: "bot", bot: updated });
        return json(res, 200, {
          visibility: updated?.visibility ?? visibility,
          ownerId: updated?.ownerId ?? null,
        });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      // multibot: sekcja sidebaru (port z OpenMausBot #296) — null/"" czyści,
      // inaczej trim i limit 60 znaków.
      if (body.section !== undefined) {
        if (body.section !== null && typeof body.section !== "string") {
          return json(res, 400, { error: "section must be a string" });
        }
        const section = typeof body.section === "string" ? body.section.trim() : "";
        if (section.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
      }
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "modelSelection", "unread", "color", "mascotExpression", "mascotShape", "pinned", "hidden", "composioAccounts", "avatarUrl", "fastMode"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (patch.fastMode !== undefined && typeof patch.fastMode !== "boolean") {
        return json(res, 400, { error: "fastMode must be boolean" });
      }
      // multibot: kolor spoza allowlisty szedl dotad prosto do bazy i wracal do
      // klienta, ktory rysowal bota domyslna zielenia — bot z zapisanym
      // "pink2" wygladal jak bez koloru. Ta sama lista, ktora waliduje
      // `managedBotPatch` (bot zmieniajacy bota).
      if (patch.color !== undefined && !BOT_COLORS.includes(patch.color as never)) {
        return json(res, 400, { error: `unknown color: must be one of ${BOT_COLORS.join(", ")}` });
      }
      // multibot: to samo dla ksztaltu — zapisany "wave" wracal do klienta,
      // ktory nie ma takiej sylwetki i rysowal czarnego kursora.
      if (patch.mascotShape !== undefined && !BOT_SHAPES.includes(patch.mascotShape as never)) {
        return json(res, 400, { error: `unknown mascotShape: must be one of ${BOT_SHAPES.join(", ")}` });
      }
      // avatarUrl validation — allow data: URL or /api/bots/:id/avatar path, max 500KB string (covers 512x512 webp base64 ~100KB)
      if (patch.avatarUrl !== undefined) {
        if (patch.avatarUrl !== null && typeof patch.avatarUrl !== "string") return json(res, 400, { error: "avatarUrl must be a string or null" });
        if (typeof patch.avatarUrl === "string" && patch.avatarUrl.length > 700_000) return json(res, 413, { error: "avatar image too large (max ~500KB)" });
        if (typeof patch.avatarUrl === "string" && patch.avatarUrl.length > 0 && !patch.avatarUrl.startsWith("data:image/") && !patch.avatarUrl.startsWith("/api/bots/") && !patch.avatarUrl.startsWith("http")) {
          return json(res, 400, { error: "avatarUrl must be data:image/* or /api/bots/... URL" });
        }
      }
      if (body.composioAccounts !== undefined) {
        if (!body.composioAccounts || typeof body.composioAccounts !== "object" || Array.isArray(body.composioAccounts)) return json(res, 400, { error: "composioAccounts must be an object" });
        const accounts: Record<string, string> = {};
        for (const [slug, id] of Object.entries(body.composioAccounts as Record<string, unknown>)) {
          if (!/^[a-z0-9_-]{1,64}$/i.test(slug) || typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return json(res, 400, { error: "invalid Composio account mapping" });
          accounts[slug] = id;
        }
        body.composioAccounts = accounts;
      }
      if (body.section !== undefined) {
        const section = typeof body.section === "string" ? body.section.trim() : "";
        patch.section = section || undefined;
      }
      const previous = store.bot(m[1]);
      // multibot: patchBot mutuje rekord w miejscu (Object.assign), więc
      // referencja `previous` widziałaby NOWĄ nazwę — poprzednią bierzemy
      // jako prymityw PRZED patchem, inaczej pigułka "renamed" nigdy nie powstanie.
      const previousName = previous?.name;
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body.chiefOfStaff !== undefined) {
        if (typeof body.chiefOfStaff !== "boolean") return json(res, 400, { error: "chiefOfStaff must be boolean" });
        store.setChiefOfStaff(bot.id, body.chiefOfStaff);
      }
      if (typeof patch.name === "string" && previousName !== bot.name) {
        appendBotEvent(bot.id, { type: "renamed", value: bot.name });
      }
      broadcast({ kind: "bot", bot });
      return json(res, 200, { bot });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      await deleteBotRecord(bot);
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/devices\/([\w-]+)\/push$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const token = String(body.token ?? "").trim();
      if (!token) return json(res, 422, { error: "token required" });
      registerPushDevice(m[1], token, body.botId ? String(body.botId) : undefined, actor?.userId);
      return json(res, 200, { ok: true });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/attachments(?:\/([0-9a-f-]+))?$/i);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (method === "POST" && !m[2]) {
        const rawName = Array.isArray(req.headers["x-file-name"]) ? req.headers["x-file-name"][0] : req.headers["x-file-name"];
        let name = "";
        try {
          name = decodeURIComponent(String(rawName ?? ""));
        } catch {
          return json(res, 422, { error: "invalid file name encoding" });
        }
        const mime = String(req.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0];
        const file = attachments.add(m[1], name, mime, await readBytes(req));
        return json(res, 201, file);
      }
      if (method === "GET" && m[2]) {
        const file = attachments.resolve(m[1], m[2]);
        const bytes = readFileSync(file.path);
        res.writeHead(200, {
          "content-type": file.mime,
          "content-length": String(bytes.length),
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=31536000, immutable",
        });
        return res.end(bytes);
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // multibot: custom avatar photo — circular crop, stored as data URL in bots.json (≤500KB)
    m = path.match(/^\/api\/bots\/([\w-]+)\/avatar$/);
    if (m) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (method === "POST") {
        const body = await readBody(req);
        const image = String(body.image ?? body.avatarUrl ?? "").trim();
        if (!image) return json(res, 422, { error: "image required (data:image/* base64)" });
        if (image.length > 700_000) return json(res, 413, { error: "avatar image too large (max ~500KB)" });
        if (!image.startsWith("data:image/")) return json(res, 422, { error: "image must be data:image/* URL" });
        const updated = store.patchBot(bot.id, { avatarUrl: image });
        broadcast({ kind: "bot", bot: updated });
        return json(res, 200, { bot: updated });
      }
      if (method === "DELETE") {
        const updated = store.patchBot(bot.id, { avatarUrl: null });
        broadcast({ kind: "bot", bot: updated });
        return json(res, 200, { bot: updated });
      }
      if (method === "GET") {
        const avatar = bot.avatarUrl;
        if (!avatar || !avatar.startsWith("data:image/")) return json(res, 404, { error: "no avatar" });
        // legacy: if avatar is data URL, decode and serve as image
        const match = avatar.match(/^data:(image\/[a-z0-9+.-]+);base64,(.*)$/i);
        if (!match) return json(res, 404, { error: "no avatar" });
        const mime = match[1].toLowerCase();
        const bytes = Buffer.from(match[2], "base64");
        res.writeHead(200, { "content-type": mime, "content-length": String(bytes.length), "cache-control": "private, max-age=3600" });
        return res.end(bytes);
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // multibot (A2): UI mówi „otworzyłem tego bota" — stawiamy mu proces CLI,
    // zanim użytkownik zdąży cokolwiek napisać. Odpowiedź leci od razu, sama
    // rozgrzewka idzie w tle; jej niepowodzenie nic nie psuje, bo pierwsza tura
    // i tak postawi proces sama (tylko wolniej).
    m = path.match(/^\/api\/bots\/([\w-]+)\/warm$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      void warmBot(m[1]).catch(() => {});
      return json(res, 202, { ok: true });
    }

    // multibot: Read aloud for every bot, not just the ones on the engine.
    // The engine's edge-tts stays the fallback for engine bots (SpeakButton
    // picks the route from `voice.configured`), so this only needs the harness
    // key path: OpenAI speech in, audio/mpeg out.
    m = path.match(/^\/api\/bots\/([\w-]+)\/speak$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const key = cfg.voice?.key;
      if (!key) return json(res, 501, { error: "no text-to-speech key configured" });
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 422, { error: "text required" });
      // OpenAI rejects longer input outright; refuse here so the button shows
      // its error state instead of waiting on a doomed request.
      if (text.length > 4096) return json(res, 413, { error: "text too long (max 4096 characters)" });
      try {
        const upstream = await fetch(process.env.MULTIBOT_TTS_URL || "https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "mp3" }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!upstream.ok) return json(res, 502, { error: `text-to-speech upstream ${upstream.status}` });
        // ponytail: whole clip buffered — one chat bubble is seconds of audio,
        // and the client reads it as a blob anyway. Stream it if long-form
        // reading ever lands.
        const bytes = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(bytes.length) });
        return res.end(bytes);
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/credential$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const requestKey = String(body.requestKey ?? "");
      const pending = pendingCredentials.get(requestKey);
      if (!pending || pending.botId !== bot.id) return json(res, 404, { error: "no such credential request" });
      const existing = store.messagesFor(bot.threadId).find((message) => message.secret?.requestKey === requestKey);
      const target = existing?.secret?.target;
      if (!isCredentialTargetId(target)) return json(res, 409, { error: "invalid credential request" });
      const dismissed = body.dismissed === true;
      if (!dismissed) {
        const value = String(body.value ?? "");
        if (!value.trim()) return json(res, 422, { error: "credential value required" });
        saveConfig(credentialConfigPatch(target, value));
        Object.assign(cfg, loadConfig());
        await reloadProviders();
      }
      pendingCredentials.delete(requestKey);
      const patched = existing
        ? store.patchMessage(bot.threadId, existing.id, { secret: { ...existing.secret!, provided: !dismissed, dismissed } })
        : null;
      if (patched) broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      pending.resolve(dismissed ? "MultiBot: user skipped credential request." : "MultiBot: credential saved securely.");
      return json(res, 200, { ok: true });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/inspector$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { events: inspectorEvents(bot.threadId, Number(url.searchParams.get("limit") ?? 100)) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/inspector\/replay$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 200) : [];
      return json(res, 200, { events: replayInspectorEvents(bot.threadId, ids) });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      // multibot: karta przekazania komputera ma trzy akcje zamiast wolnego
      // tekstu. `takeover` NIE zamyka karty — człowiek dopiero zaczyna robotę.
      const option = typeof body.option === "string" ? body.option : "";
      if (option === "takeover" || option === "done" || option === "skip") {
        if (option === "takeover") {
          computerControl.acquire();
          broadcast({ kind: "computer", botId: bot.id, state: "user-control" });
          return json(res, 200, { message: existing, ...computerControl.control() });
        }
        // oddajemy sterowanie agentowi i odblokowujemy jego turę
        computerControl.release();
        broadcast({ kind: "computer-queue", ...computerControl.control() });
        broadcast({ kind: "computer", botId: bot.id, state: "ready" });
        const note = String(body.note ?? "").trim();
        const requestId = String(existing.card.requestId ?? "");
        const pending = pendingUserAsks.get(requestId);
        if (pending) {
          pendingUserAsks.delete(requestId);
          pending(option === "done" ? (note ? `user finished: ${note}` : "user finished") : "user skipped");
        }
        const settled = store.patchMessage(bot.threadId, m[2], {
          card: { ...existing.card, answered: option, dismissed: option === "skip" },
        });
        broadcast({ kind: "message.patch", threadId: bot.threadId, message: settled });
        return json(res, 200, { message: settled });
      }
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      const turnAttachments = attachments.resolveMany(m[1], body.attachmentIds);
      if (!text && !turnAttachments.length) return json(res, 400, { error: "text or attachment required" });
      // multibot: flat reply — walidacja celu zanim cokolwiek pójdzie w turę
      const replyBot = store.bot(m[1]);
      if (!replyBot) return json(res, 404, { error: "no such bot" });
      const replyTarget = resolveReplyTarget(store.messagesFor(replyBot.threadId), body.replyToId);
      if (body.replyToId && !replyTarget) return json(res, 404, { error: "no such message to reply to" });
      const turnText = replyTarget ? promptWithReply(text, replyTarget, replyBot.name) : text;
      const reasoning = isReasoningLevel(body.reasoning) ? body.reasoning : undefined;
      let taskText = text;
      let modelReply = turnAttachments.length ? null : await handleModelCommand(store.bot(m[1]), text);
      if (modelReply === null && !turnAttachments.length) {
        const goalReply = await handleGoalCommand(store.bot(m[1]), text);
        if (goalReply !== null) {
          const bot = store.bot(m[1]);
          if (!bot) return json(res, 404, { error: "no such bot" });
          const userMessage = store.appendMessage(bot.threadId, {
            role: "user",
            kind: "text",
            text,
            ...actorMessageFields(actor),
            ...(replyTarget ? { replyToId: replyTarget.id } : {}),
          });
          const botMessage = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: goalReply });
          broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
          broadcast({ kind: "message", threadId: bot.threadId, message: botMessage });
          return json(res, 200, { ok: true, command: "goal" });
        }
      }
      if (modelReply === null && !turnAttachments.length && /\b(?:użyj|uzyj|use|wybierz|choose|pracuj|work)\b/i.test(text)) {
        const bot = store.bot(m[1]);
        const request = bot ? detectOneShotModelRequest(text, await registry.describe()) : null;
        if (request && request.candidate.instanceId === bot?.modelSelection.instanceId) {
          store.patchBot(bot.id, { pendingModelOverride: request.model });
          taskText = stripModelRequest(text, request);
          if (!taskText) modelReply = `Model for the next task: ${request.label} (one turn only).`;
        }
      }
      if (modelReply !== null) {
        const bot = store.bot(m[1]);
        if (!bot) return json(res, 404, { error: "no such bot" });
        const userMessage = store.appendMessage(bot.threadId, { role: "user", kind: "text", text, ...actorMessageFields(actor) });
        const botMessage = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: modelReply });
        broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
        broadcast({ kind: "message", threadId: bot.threadId, message: botMessage });
        return json(res, 200, { ok: true, command: "model" });
      }
      // multibot: user @mentions another bot with a task → the author hands it
      // to the tagged peers as real turns and the answers come back the same
      // way, in the room the user can open from the chat. Odpowiedź HTTP
      // wraca od razu; rozmowa toczy się dalej sama.
      const collab = maybeStartCollab(m[1], taskText);
      if (collab) {
        const botId = m[1];
        const owner = store.bot(botId)!;
        const userMessage = store.appendMessage(owner.threadId, {
          role: "user",
          kind: "text",
          text,
          ...actorMessageFields(actor),
          ...(replyTarget ? { replyToId: replyTarget.id } : {}),
        });
        broadcast({ kind: "message", threadId: owner.threadId, message: userMessage });
        // The chip comes from the delivery below, one per recipient.
        for (const peerId of collab.room.bot_ids.filter((id) => id !== botId)) {
          void deliverPeerMessage(botId, peerId, collab.task, collab.room.id);
        }
        return json(res, 202, { ok: true, room: collab.room.id });
      }
      // multibot: KAŻDA wiadomość idzie przez kolejkę — i ta wysłana w trakcie
      // tury (0.1.44: zamiast 409), i ta wysłana do wolnego bota. Bańka ląduje
      // w wątku od razu, a tura rusza po oknie `OMB_TURN_DEBOUNCE_MS`, więc
      // trzy zdania wysłane pod rząd to JEDNA tura i JEDNA odpowiedź, nie trzy.
      const target = store.bot(m[1]);
      if (!target) return json(res, 404, { error: "no such bot" });
      // Dostawca sprawdzany TU, a nie dopiero przy starcie tury: bot wpięty w
      // nieistniejącą instancję ma paść głośno na wysyłce, nie 202-i-cisza.
      if (!registry.get(target.modelSelection.instanceId)) {
        return json(res, 409, {
          error: `provider instance "${target.modelSelection.instanceId}" is unavailable — pick another model in settings`,
        });
      }
      const userMessage = store.appendMessage(target.threadId, {
        role: "user",
        kind: "text",
        text,
        ...actorMessageFields(actor),
        ...(replyTarget ? { replyToId: replyTarget.id } : {}),
        // multibot (F12): badge modelu wisi na wiadomości usera, a tę dopisuje
        // teraz kolejka, nie `startTurn` — override trzeba odczytać tutaj.
        ...(target.pendingModelOverride ? { model: target.pendingModelOverride } : {}),
        ...(turnAttachments.length
          ? { attachments: turnAttachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })) }
          : {}),
      });
      broadcast({ kind: "message", threadId: target.threadId, message: userMessage });
      // multibot (0.3.31): zwykły tekst wysłany w trakcie tury GPT-6 Astra idzie
      // PROSTO do niej (`turn/steer`) — korekta trafia do bota, gdy jeszcze ma
      // znaczenie, zamiast czekać na koniec pracy. Załącznik, reply i cokolwiek
      // z ukośnikiem zostają przy kolejce: tylko goły tekst da się dopisać do
      // promptu trwającej tury bez zmiany jej kontraktu.
      const queueOpts = { attachments: turnAttachments, reasoning, actor };
      const plainText = !turnAttachments.length && !replyTarget && !text.startsWith("/");
      let delivery: "steered" | "queued" = "queued";
      if (plainText) {
        delivery = await deliverToActiveTurnOrQueue(target.id, turnText, "user", queueOpts);
        // Steered INTO a running turn: that turn now also answers the user, so
        // its text stays a visible bubble even if a colleague started it.
        if (delivery === "steered") turnUserText.add(target.threadId);
      } else {
        queueUserTurn(target.id, turnText, queueOpts);
      }
      return json(res, 202, { ok: true, queued: delivery === "queued" && Boolean(target.busy), delivery });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      // multibot: pytanie z `ask_user` nie przechodzi przez drivera — czeka
      // tutaj. Rozstrzygamy je przed sięgnięciem po instancję, żeby chwilowo
      // niedostępny dostawca nie blokował odpowiedzi na własne pytanie bota.
      const pendingAsk = pendingUserAsks.get(String(body.requestId));
      if (pendingAsk) {
        pendingUserAsks.delete(String(body.requestId));
        pendingAsk(String(body.message ?? "").trim() || USER_ASK_DISMISS_NOTE);
        return json(res, 200, { ok: true });
      }
      const instance = registry.get(bot.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      if (!["allow", "always", "deny", "answer"].includes(body.behavior)) {
        return json(res, 422, { error: "invalid decision" });
      }
      if (body.behavior === "always") {
        const candidate = approvalRuleByRequest.get(String(body.requestId));
        if (!candidate) return json(res, 409, { error: "this request cannot be remembered safely" });
        workspace.addApprovalRule(bot.id, candidate);
        rememberApprovalRule(bot.threadId, candidate);
        broadcast({ kind: "workspace", botId: bot.id, resource: "approval-rules" });
      }
      await instance.adapter.respondToRequest(bot.threadId, String(body.requestId), {
        behavior: body.behavior,
        message: body.message,
      });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const instance = registry.get(bot.modelSelection.instanceId);
      store.patchBot(bot.id, { busy: false });
      clearTurnPolicy(bot.threadId);
      activeCommsDepth.delete(bot.id);
      peerTurn.delete(bot.id); // przerwana tura nie odpisuje koledze
      groupTurn.get(bot.id)?.done("");
      turnAssistantText.delete(bot.threadId);
      turnUsedTool.delete(bot.threadId);
      turnUserText.delete(bot.threadId);
      stopScreenPoller(bot.id);
      releaseTurnSlot(bot.id);
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      await instance?.adapter.interruptTurn(bot.threadId);
      drainQueuedUserMessages(bot.id);
      return json(res, 200, { ok: true });
    }

    // ── multibot: provider-neutral workspace ───────────────────────────
    m = path.match(/^\/api\/bots\/([\w-]+)\/approval-rules(?:\/([\w-]+))?$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (method === "GET" && !m[2]) return json(res, 200, workspace.approvalRules(m[1]));
      if (method === "DELETE" && m[2]) {
        const ok = workspace.removeApprovalRule(m[1], m[2]);
        if (ok) broadcast({ kind: "workspace", botId: m[1], resource: "approval-rules" });
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such rule" });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    m = path.match(/^\/api\/memory\/team\/facts(?:\/([\w-]+))?$/);
    if (m) {
      if (method === "GET" && !m[1]) return json(res, 200, workspace.teamFacts(url.searchParams.get("q") ?? ""));
      if (method === "POST" && !m[1]) {
        const fact = workspace.addTeamFact(await readBody(req));
        broadcast({ kind: "workspace", resource: "team-memory" });
        return json(res, 201, fact);
      }
      if (method === "PATCH" && m[1]) {
        const fact = workspace.patchTeamFact(m[1], await readBody(req));
        if (fact) broadcast({ kind: "workspace", resource: "team-memory" });
        return fact ? json(res, 200, fact) : json(res, 404, { error: "no such fact" });
      }
      if (method === "DELETE" && m[1]) {
        const ok = workspace.deleteTeamFact(m[1]);
        if (ok) broadcast({ kind: "workspace", resource: "team-memory" });
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such fact" });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (method === "GET" && path === "/api/memory/team/markdown") {
      return json(res, 200, workspace.teamMarkdown());
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/memory/team/markdown") {
      const markdown = workspace.putTeamMarkdown((await readBody(req)).content);
      broadcast({ kind: "workspace", resource: "team-memory" });
      return json(res, 200, markdown);
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/facts(?:\/([\w-]+))?$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (method === "GET" && !m[2]) return json(res, 200, workspace.facts(m[1], url.searchParams.get("q") ?? ""));
      if (method === "POST" && !m[2]) {
        const body = await readBody(req);
        const fact = workspace.addFact(m[1], body);
        broadcast({ kind: "workspace", botId: m[1], resource: "memory" });
        return json(res, 201, fact);
      }
      if (method === "PATCH" && m[2]) {
        const body = await readBody(req);
        const fact = workspace.patchFact(m[1], m[2], body);
        if (fact) broadcast({ kind: "workspace", botId: m[1], resource: "memory" });
        return fact ? json(res, 200, fact) : json(res, 404, { error: "no such fact" });
      }
      if (method === "DELETE" && m[2]) {
        const ok = workspace.deleteFact(m[1], m[2]);
        if (ok) broadcast({ kind: "workspace", botId: m[1], resource: "memory" });
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such fact" });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/markdown$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (method === "GET") return json(res, 200, workspace.markdown(m[1]));
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(req);
        const markdown = workspace.putMarkdown(m[1], body.content);
        broadcast({ kind: "workspace", botId: m[1], resource: "memory" });
        return json(res, 200, markdown);
      }
      return json(res, 405, { error: "method not allowed" });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/graph$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      return json(res, 200, workspace.graph(m[1]));
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/skills(?:\/(.+))?$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const name = m[2] ? decodeURIComponent(m[2]) : null;
      if (method === "GET" && !name) return json(res, 200, workspace.skills(m[1]));
      if (method === "POST" && !name) {
        const body = await readBody(req);
        const skill = workspace.addSkill(m[1], body);
        // multibot: ta sama pigułka w transkrypcie co przy `skills.create` z
        // narzędzia bota — skill utworzony z panelu był dotąd niewidoczny
        // w czacie, choć powstaje dokładnie tak samo.
        appendBotEvent(m[1], { type: "skill-created", value: skill.name });
        broadcast({ kind: "workspace", botId: m[1], resource: "skills" });
        return json(res, 201, skill);
      }
      if (method === "PATCH" && name) {
        const body = await readBody(req);
        const skill = workspace.patchSkill(m[1], name, body);
        if (skill) broadcast({ kind: "workspace", botId: m[1], resource: "skills" });
        return skill ? json(res, 200, skill) : json(res, 404, { error: "no such skill" });
      }
      if (method === "DELETE" && name) {
        const ok = workspace.deleteSkill(m[1], name);
        if (ok) broadcast({ kind: "workspace", botId: m[1], resource: "skills" });
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such skill" });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // Nagrywarka demonstracji: wpina się w przeglądarkę komputera przez CDP i
    // zbiera kliknięcia, wpisy i nawigacje. `stop` oddaje gotowe kroki, które
    // panel wysyła do `teach/synthesize` niżej — nagranie nigdzie nie zostaje.
    m = path.match(/^\/api\/bots\/([\w-]+)\/teach\/(start|stop)$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // Recording watches the bot's browser, so it answers to the same switch
      // the browser tools do — a bot with browser access off must not become a
      // way to observe that browser either.
      if (!canUseIntegration(bot.threadId, "browser")) {
        return json(res, 403, { error: "this bot has no browser access" });
      }
      try {
        if (m[2] === "start") {
          await ensureComputer();
          return json(res, 200, await teach.start(bot.id));
        }
        const body = await readBody(req);
        const id = typeof body?.recording_id === "string" ? body.recording_id : undefined;
        return json(res, 200, teach.stop(bot.id, id));
      } catch (e) {
        const status = (e as { status?: number }).status ?? 502;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Lista kroków → skill, tym samym providerem, co reszta pracy bota.
    // Patrz `teachSynthesisPrompt`.
    m = path.match(/^\/api\/bots\/([\w-]+)\/teach\/synthesize$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      // Kroki idą w jeden prompt, a `readBody` puszcza megabajt — stąd sufit na
      // liczbę i długość. Demonstracja to kilkadziesiąt kliknięć, nie powieść.
      const steps: string[] = (Array.isArray(body?.steps) ? body.steps : [])
        .slice(0, 200)
        .map((step: unknown) => String(step).trim().slice(0, 500))
        .filter(Boolean);
      if (!steps.length) return json(res, 422, { error: "steps must be a non-empty array" });
      const wanted = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : null;
      // Kolizję nazwy sprawdzamy PRZED turą: `addSkill` rzuca 409 dopiero po
      // niej, więc użytkownik tracił kilka minut pracy modelu na literówkę.
      if (wanted && workspace.skills(bot.id).some((skill) => skill.name.toLowerCase() === wanted.toLowerCase())) {
        return json(res, 409, { error: "skill already exists" });
      }
      // Izolowana nitka jak przy delegacji: prompt i odpowiedź nie zaśmiecają
      // czatu, a `transcript: []` trzyma tę turę z dala od historii wątku.
      // `activeCommsDepth` jak w `delegatedPeerTurn` — bez znacznika izolowana
      // tura mogłaby zacząć łańcuch delegacji od zera.
      activeCommsDepth.set(bot.id, 1);
      let reply: string;
      try {
        reply = await askBotAndWait(bot.id, teachSynthesisPrompt(steps, wanted), 0, {
          threadId: `teach-${bot.id}`,
          transcript: [],
          timeoutMs: 240_000,
        });
      } finally {
        if ((activeCommsDepth.get(bot.id) ?? 0) <= 1) activeCommsDepth.delete(bot.id);
        drainQueuedUserMessages(bot.id); // izolowana tura nie opróżnia kolejki sama
      }
      const draft = parseSkillDraft(reply);
      if (!draft) {
        throw Object.assign(new Error(`the bot did not return a skill: ${reply.slice(0, 300)}`), { status: 502 });
      }
      const skill = workspace.addSkill(bot.id, { ...draft, name: wanted ?? draft.name });
      appendBotEvent(bot.id, { type: "skill-created", value: skill.name });
      broadcast({ kind: "workspace", botId: bot.id, resource: "skills" });
      return json(res, 201, { skill_name: skill.name });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/(access|autonomy|permissions|usage)$/);
    if (m) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (m[2] === "usage") {
        return method === "GET"
          ? json(res, 200, workspace.usage(m[1]))
          : json(res, 405, { error: "method not allowed" });
      }
      if (m[2] === "access") {
        if (method === "GET") return json(res, 200, workspace.access(m[1]));
        if (method === "PATCH") return json(res, 200, workspace.setAccess(m[1], (await readBody(req)).access));
      }
      if (m[2] === "autonomy") {
        if (method === "GET") return json(res, 200, workspace.autonomy(m[1]));
        if (method === "PATCH") return json(res, 200, workspace.setAutonomy(m[1], (await readBody(req)).autonomy));
      } else {
        if (method === "GET") return json(res, 200, workspace.permissions(m[1]));
        if (method === "PATCH") {
          const body = await readBody(req);
          const patch = typeof body.toolset === "string" ? { [body.toolset]: body.enabled } : body;
          return json(res, 200, workspace.setPermissions(m[1], patch));
        }
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // ── multibot: driver-neutral routines ──────────────────────────────
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      return json(res, 200, harnessRoutines.list(m[1]).map((routine) => routineView(m![1], routine)));
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      try {
        const routine = harnessRoutines.create(m[1], {
          name: body.name,
          prompt: body.prompt,
          schedule: body.schedule,
        });
        broadcast({ kind: "workspace", botId: m[1], resource: "routines" });
        return json(res, 201, routineView(m[1], routine));
      } catch (error) {
        return json(res, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines\/([\w-]+)$/);
    if (m && method === "PATCH") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const patch: Partial<Pick<HarnessRoutine, "name" | "prompt" | "schedule" | "enabled">> = {};
      for (const key of ["name", "prompt", "schedule", "enabled"] as const) {
        if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
      }
      try {
        const routine = harnessRoutines.update(m[1], m[2], patch);
        if (routine) broadcast({ kind: "workspace", botId: m[1], resource: "routines" });
        return routine
          ? json(res, 200, routineView(m[1], routine))
          : json(res, 404, { error: "no such routine" });
      } catch (error) {
        return json(res, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (m && method === "DELETE") {
      const ok = harnessRoutines.delete(m[1], m[2]);
      if (ok) broadcast({ kind: "workspace", botId: m[1], resource: "routines" });
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such routine" });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines\/([\w-]+)\/(run|webhook)$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // multibot (webhook): rutyny CLI dostają trigger webhooka jak rutyny
      // silnika. Sekret oddajemy RAZ, przy włączeniu; re-enable nie rotuje.
      if (m[3] === "webhook") {
        const hook = harnessRoutines.enableWebhookTrigger(m[1], m[2]);
        if (!hook) return json(res, 404, { error: "no such routine" });
        broadcast({ kind: "workspace", botId: m[1], resource: "routines" });
        return json(res, 200, hook);
      }
      const routine = await harnessRoutines.runNow(m[1], m[2]);
      if (!routine) return json(res, 404, { error: "no such routine" });
      const run = routine.last_runs[0];
      if (run?.status === "error") return json(res, 409, { error: run.error, routine: routineView(m[1], routine) });
      return json(res, 200, routineView(m[1], routine));
    }

    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, {
        app: "multibot",
        pid: process.pid,
        static: Boolean(STATIC_DIR),
        service: process.env.OMB_SERVER_SERVICE === "1",
      });
    }

    // Cheap "is this credential still good?" probe for the clients.
    if (method === "GET" && path === "/api/auth/check") {
      return json(res, 200, { ok: true });
    }
    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      const kind = url.searchParams.get("type") ?? "all";
      const results: SearchResult[] = [];
      for (const bot of store.bots) {
        if (!canReadBot(bot, actor)) continue;
        if (searchText(query, bot.name, bot.title, bot.description)) {
          results.push({ id: `agent:${bot.id}`, kind: "agent", title: bot.name, subtitle: bot.title || bot.description || "Agent", botId: bot.id });
        }
        for (const skill of workspace.skills(bot.id)) {
          if (searchText(query, skill.name, skill.instructions)) {
            results.push({ id: `skill:${bot.id}:${skill.name}`, kind: "skill", title: skill.name, subtitle: `${bot.name} · Skill`, botId: bot.id });
          }
        }
        for (const routine of harnessRoutines.list(bot.id)) {
          if (searchText(query, routine.name, routine.prompt)) {
            results.push({ id: `routine:${bot.id}:${routine.id}`, kind: "routine", title: routine.name, subtitle: `${bot.name} · Routine`, botId: bot.id, at: routine.nextRunAt ?? 0 });
          }
        }
        for (const message of chatMessages(bot.threadId)) {
          if (message.text && searchText(query, message.text, bot.name)) {
            results.push({ id: `message:${bot.id}:${message.id}`, kind: "message", title: message.text.slice(0, 120), subtitle: bot.name, botId: bot.id, at: message.at });
            for (const match of message.text.matchAll(/https?:\/\/[^\s<>)]+/g)) {
              const href = match[0].replace(/[.,;:]+$/, "");
              if (searchText(query, href, bot.name)) results.push({ id: `link:${bot.id}:${message.id}:${href}`, kind: "link", title: href, subtitle: bot.name, botId: bot.id, href, at: message.at });
            }
          }
          for (const file of message.attachments ?? []) {
            if (searchText(query, file.name, bot.name)) {
              results.push({ id: `file:${bot.id}:${file.id}`, kind: "file", title: file.name, subtitle: `${bot.name} · ${file.size} B`, botId: bot.id, at: message.at });
            }
          }
        }
      }
      for (const group of groupStore.list()) {
        if (!groupVisible(group, actor)) continue;
        if (searchText(query, group.name, group.bot_ids.join(" "))) {
          results.push({ id: `group:${group.id}`, kind: "group", title: group.name || group.id, subtitle: `${group.bot_ids.length} bots`, groupId: group.id });
        }
        for (const message of group.messages) {
          if (searchText(query, message.text, group.name)) {
            results.push({ id: `group-message:${group.id}:${message.id}`, kind: "message", title: message.text.slice(0, 120), subtitle: group.name || group.id, groupId: group.id, at: message.at });
          }
        }
      }
      return json(res, 200, { results: filterSearchResults(results, query, kind) });
    }

    if (method === "GET" && path === "/api/instances") {
      return json(res, 200, { instances: await registry.describe() });
    }

    // multibot: live team map (port z OpenMausBot, GET /api/team-map)
    if (method === "GET" && path === "/api/team-map") {
      const collaborations = groupStore
        .list()
        .filter((group) => groupVisible(group, actor))
        .filter((group) => group.bot_ids.length === 2)
        .map((group) => ({
          groupId: group.id,
          botIds: [group.bot_ids[0]!, group.bot_ids[1]!] as [string, string],
          lastAt: group.messages[group.messages.length - 1]?.at ?? group.createdAt,
        }));
      return json(res, 200, { collaborations, queued: [], running: [] });
    }

    // multibot: scout folderu → manifest zespołu (port z OpenMausBot #339)
    if (method === "GET" && path === "/api/teams/scout") {
      const cwd = url.searchParams.get("cwd") ?? "";
      if (!cwd || !isAbsolute(cwd)) return json(res, 400, { error: "cwd must be an absolute path" });
      const manifest = scoutProject(cwd);
      if ("kind" in manifest) return json(res, 404, manifest);
      return json(res, 200, { manifest });
    }

    // multibot: import manifestu scouta — tworzy boty addytywnie, nigdy nie
    // modyfikuje istniejących (każdy rekord dostaje świeże id z POST /api/bots).
    if (method === "POST" && path === "/api/teams/import") {
      const body = await readBody(req);
      const roles: Array<{ name: string; role: string; description: string }> = Array.isArray(body?.manifest?.specialists) && Array.isArray(body?.manifest?.lead)
        ? []
        : [
          body?.manifest?.lead,
          ...(Array.isArray(body?.manifest?.specialists) ? body.manifest.specialists : []),
        ].filter((r): r is { name: string; role: string; description: string } => Boolean(r?.name && r?.role));
      if (!roles.length) return json(res, 422, { error: "manifest must include a lead" });
      const created: Array<{ id: string; name: string }> = [];
      for (const role of roles) {
        const bot = store.createBot();
        store.patchBot(bot.id, {
          name: typeof role.name === "string" && role.name.trim() ? role.name.trim().slice(0, 80) : role.role.slice(0, 80),
          title: typeof role.role === "string" ? role.role.slice(0, 80) : "",
          description: typeof role.description === "string" ? role.description.slice(0, 500) : "",
          ownerId: actor?.userId,
          visibility: "team",
        });
        const fresh = store.bot(bot.id)!;
        created.push({ id: fresh.id, name: fresh.name });
        broadcast({ kind: "bot", bot: fresh });
      }
      return json(res, 201, { created });
    }

    // ── multibot (G3): device scan + background setup progress ─────────
    if (method === "GET" && path === "/api/device") {
      return json(res, 200, await deviceInfo());
    }
    if (method === "GET" && path === "/api/device/resources") {
      return json(res, 200, deviceResources());
    }
    m = path.match(/^\/api\/progress\/([\w-]+)$/);
    if (m && method === "GET") {
      const job = setupJobs.get(m[1]);
      if (!job) return json(res, 404, { error: "no such setup job" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (next: typeof job) => res.write(`data: ${JSON.stringify(jobProgress(next))}\n\n`);
      let unsubscribe = () => {};
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25_000);
      let ended = false;
      const cleanup = () => {
        if (ended) return;
        ended = true;
        clearInterval(keepalive);
        unsubscribe();
      };
      unsubscribe = setupJobs.subscribe(job.id, (next) => {
        if (ended) return;
        send(next);
        if (next.status !== "running") {
          cleanup();
          res.end();
        }
      });
      req.on("close", cleanup);
      // Subscribe before re-reading: a fast installer can otherwise finish
      // between the initial GET and listener registration, leaving SSE open.
      const current = setupJobs.get(job.id)!;
      send(current);
      if (current.status !== "running") {
        cleanup();
        return res.end();
      }
      return;
    }

    // ── multibot (G1): named custom models + persistent CLI allow switches ──
    if (method === "GET" && path === "/api/models/custom") {
      return json(res, 200, { models: customModelsStatus() });
    }
    m = path.match(/^\/api\/models\/custom\/([a-z0-9-]+)\/probe$/);
    if (m && method === "POST") return json(res, 200, await probeCustomModel(m[1]));
    m = path.match(/^\/api\/models\/custom\/([a-z0-9-]+)$/);
    if (m && method === "PUT") {
      const id = m[1];
      const body = await readBody(req);
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/$/, "") : "";
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(id)) return json(res, 400, { error: "invalid model id" });
      if (RESERVED_INSTANCE_IDS.has(id)) return json(res, 409, { error: "reserved model id" });
      if (!displayName || displayName.length > 80) return json(res, 400, { error: "displayName required (max 80)" });
      if (!validBaseUrl(baseUrl)) return json(res, 400, { error: "baseUrl must be an http(s) URL without credentials" });
      if (!model || model.length > 200) return json(res, 400, { error: "model required (max 200)" });
      if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
        return json(res, 400, { error: "apiKey must be a string" });
      }
      const existing = cfg.instances?.[id];
      if (existing && existing.driver !== "openaiCompatible") return json(res, 409, { error: "instance id already used" });
      const apiKey = body.apiKey === undefined ? existing?.environment?.OPENAI_API_KEY : body.apiKey.trim();
      const environment = {
        ...(existing?.environment ?? {}),
        ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
      };
      if (!apiKey) delete environment.OPENAI_API_KEY;
      const instances = {
        ...(cfg.instances ?? {}),
        [id]: {
          driver: "openaiCompatible",
          displayName,
          environment,
          model: { default: model, baseUrl },
        },
      };
      saveConfig({ instances });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const saved = customModelsStatus().find((item) => item.id === id)!;
      broadcast({ kind: "config", ...configStatus() });
      return json(res, 200, { model: saved });
    }
    if (m && method === "DELETE") {
      const existing = cfg.instances?.[m[1]];
      if (!existing || existing.driver !== "openaiCompatible" || RESERVED_INSTANCE_IDS.has(m[1])) {
        return json(res, 404, { error: "no such custom model" });
      }
      const instances = { ...(cfg.instances ?? {}) };
      delete instances[m[1]];
      saveConfig({ instances });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      broadcast({ kind: "config", ...configStatus() });
      return json(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/cli-tools") {
      return json(res, 200, { tools: await cliToolsStatus() });
    }
    m = path.match(/^\/api\/cli-tools\/([a-z0-9-]+)\/login$/);
    if (m && method === "POST") {
      const toolId = m[1];
      const tool = CLI_TOOLS.find((item) => item.id === toolId);
      if (!tool) return json(res, 404, { error: "no such command-line tool" });
      if (!tool.login) return json(res, 409, { error: "interactive login unavailable; use official CLI instructions" });
      const temp = join(DATA_DIR, "tmp");
      mkdirSync(temp, { recursive: true });
      const job = setupJobs.startInteractive({
        key: `cli-login:${tool.id}`,
        kind: "cli-login",
        title: `Sign in ${tool.displayName}`,
        command: tool.login.command,
        args: tool.login.args,
        cwd: DATA_DIR,
        env: { TMP: temp, TEMP: temp },
      });
      return json(res, 202, { id: job.id, job });
    }
    m = path.match(/^\/api\/progress\/([\w-]+)\/(input|stop)$/);
    if (m && method === "POST") {
      const job = setupJobs.get(m[1]);
      if (!job) return json(res, 404, { error: "no such setup job" });
      if (job.kind !== "cli-login") return json(res, 409, { error: "job does not accept interactive input" });
      if (m[2] === "stop") return json(res, setupJobs.stop(m[1]) ? 200 : 409, { ok: true });
      const body = await readBody(req);
      if (typeof body.text !== "string") return json(res, 400, { error: "text required" });
      return json(res, setupJobs.input(m[1], body.text) ? 200 : 409, { ok: true });
    }
    m = path.match(/^\/api\/cli-tools\/([a-z0-9-]+)\/install$/);
    if (m && method === "POST") {
      const toolId = m[1];
      const tool = CLI_TOOLS.find((item) => item.id === toolId);
      if (!tool) return json(res, 404, { error: "no such command-line tool" });
      const install = cliInstallSpec(tool);
      if (!install) return json(res, 409, { error: "automatic install unavailable; use official CLI instructions" });
      const temp = join(DATA_DIR, "tmp");
      mkdirSync(temp, { recursive: true });
      const job = setupJobs.start({
        key: `cli-install:${tool.id}`,
        kind: "cli-install",
        title: `Install ${tool.displayName}`,
        command: install.command,
        args: install.args,
        cwd: DATA_DIR,
        env: { TMP: temp, TEMP: temp, ELECTRON_RUN_AS_NODE: "1" },
      });
      return json(res, 202, { id: job.id, job });
    }
    m = path.match(/^\/api\/cli-tools\/([a-z0-9-]+)$/);
    if (m && method === "PUT") {
      if (!(BUILT_IN_CLI_IDS as readonly string[]).includes(m[1])) {
        return json(res, 404, { error: "no such command-line tool" });
      }
      const body = await readBody(req);
      if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled must be boolean" });
      const id = m[1] as (typeof BUILT_IN_CLI_IDS)[number];
      const instances = {
        ...(cfg.instances ?? {}),
        [id]: { ...DEFAULT_INSTANCE_CONFIGS[id], ...(cfg.instances?.[id] ?? {}), enabled: body.enabled },
      };
      saveConfig({ instances });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const tool = (await cliToolsStatus()).find((item) => item.id === id)!;
      broadcast({ kind: "config", ...configStatus() });
      return json(res, 200, { tool });
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatusFor(actor));
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      for (const key of ["xai", "composio", "box"] as const) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (body.opencode !== undefined) {
        if (!body.opencode || typeof body.opencode !== "object" || Array.isArray(body.opencode)
          || typeof (body.opencode as { key?: unknown }).key !== "string") {
          return json(res, 400, { error: "opencode.key must be a string" });
        }
        patch.opencode = { key: (body.opencode as { key: string }).key.trim() };
      }
      // multibot: strefa i autoweryfikacja to ustawienia aplikacji, nie
      // poświadczenia serwera — osobny worek, żeby nie wpadły ani pod bramkę
      // "owner only", ani pod przeładowanie floty niżej (jak profil).
      // `autoVerify` scalamy z zapisanym stanem, więc UI może przysłać samo
      // `{enabled}` albo samą listę `rules` i nie wyzeruje tym drugiego.
      const settings: Partial<AppConfig> = {};
      // Nazwa wyświetlana należy do KONTA — każdy zmienia swoją, przez identity.
      // `cfg.profile` jest natomiast wspólny dla całego serwera (fallback, gdy
      // konta nie ma), więc pisze do niego wyłącznie owner; inaczej dowolny
      // członek nadpisywał nazwę i e-mail wszystkim. E-mail zostaje w
      // config.json do czasu, aż PR 2 doda `users.email`.
      let profileSaved = false;
      if (body.profile && typeof body.profile === "object") {
        const displayName = (body.profile as { name?: unknown }).name;
        if (typeof displayName === "string" && displayName.trim()) {
          if (displayName.length > 80) return json(res, 422, { error: "display name must be 1-80 characters" });
          if (actor) {
            actor = identity.updateProfile(actor, displayName);
            profileSaved = true;
          }
        }
        if (actor?.role === "owner") settings.profile = body.profile;
      }
      if (typeof body.timeZone === "string") settings.timeZone = body.timeZone.trim();
      if (body.autoVerify && typeof body.autoVerify === "object") {
        settings.autoVerify = normalizeAutoVerify({
          ...normalizeAutoVerify(cfg.autoVerify),
          ...(body.autoVerify as Partial<AutoVerifyState>),
        });
      }
      // multibot: pełna, nowa kolejność sekcji — bez scalania, bo przestawienie
      // musi umieć też usunąć nazwę, której już nikt nie używa.
      if (Array.isArray(body.sectionOrder)) {
        settings.sectionOrder = [...new Set(
          (body.sectionOrder as unknown[])
            .filter((name): name is string => typeof name === "string")
            .map((name) => name.trim().slice(0, 60))
            .filter(Boolean),
        )].slice(0, 200);
      }
      if (Object.keys(patch).length && actor?.role !== "owner") return json(res, 403, { error: "owner access required for server credentials" });
      if (!Object.keys(patch).length && !Object.keys(settings).length && !profileSaved) {
        return json(res, 400, { error: "nothing to save" });
      }
      if (Object.keys(patch).length || Object.keys(settings).length) {
        saveConfig({ ...(patch as Partial<AppConfig>), ...settings });
      }
      Object.assign(cfg, loadConfig());
      // provider keys change the fleet; a profile edit must not kill
      // in-flight turns with a pointless reload
      if (Object.keys(patch).length) await reloadProviders();
      const status = configStatusFor(actor);
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      // multibot (F7): własne serwery MCP użytkownika doklejone do katalogu
      // Composio; `source` per karta mówi UI, którą trasą je odłączyć.
      const tagged = [
        ...cards.map((c) => ({ ...c, source: "composio" as const })),
        ...mcpConnectors.connectorCards(cfg).map((c) => ({ ...c, source: "custom" as const })),
      ];
      return json(res, 200, { configured: Boolean(cfg.composio?.key), source, cards: tagged });
    }
    // multibot (F7): rejestr własnych konektorów. Osobna ścieżka `/custom/`,
    // żeby nie mieszać się z `DELETE /api/connectors/:slug` Composio.
    m = path.match(/^\/api\/connectors\/custom\/([\w-]+)$/);
    if (m && (method === "PUT" || method === "POST")) {
      const body = await readBody(req);
      try {
        const connector = mcpConnectors.saveConnector(m[1], body);
        Object.assign(cfg, loadConfig());
        return json(res, 200, { connector });
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (m && method === "DELETE") {
      mcpConnectors.removeConnector(m[1]);
      Object.assign(cfg, loadConfig());
      return json(res, 200, { ok: true });
    }
    // multibot (Google Workspace): preset samohostowanego workspace-mcp —
    // status/zapis/wylogowanie. Osobna trasa (nie /custom/:id), bo spec buduje
    // SERWER: ścieżka venvu i katalog credentials są per-host.
    if (method === "GET" && path === "/api/connectors/google-workspace") {
      return json(res, 200, googleWorkspace.googleWorkspaceStatus());
    }
    if (method === "PUT" && path === "/api/connectors/google-workspace") {
      const body = await readBody(req);
      try {
        const connector = googleWorkspace.saveGoogleWorkspace(
          String(body.clientId ?? ""),
          String(body.clientSecret ?? ""),
        );
        Object.assign(cfg, loadConfig());
        return json(res, 200, { connector, ...googleWorkspace.googleWorkspaceStatus() });
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "DELETE" && path === "/api/connectors/google-workspace/credentials") {
      googleWorkspace.resetGoogleWorkspaceCredentials();
      return json(res, 200, googleWorkspace.googleWorkspaceStatus());
    }

    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!cfg.composio?.key) return json(res, 200, { configured: false, services: {} });
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, await composio.authorizeService(cfg, m[1], typeof body.alias === "string" ? body.alias : undefined));
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
    if (m && method === "DELETE") {
      await composio.removeAccount(cfg, m[1], m[2]);
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeService(cfg, m[1]));

    // ── multibot (H2/H4/H5): the bot's computer ────────────────────────
    // Ports are deliberately absent from every response: the client reaches the
    // screen only through the proxy below, so a container port never leaves the
    // host. Box's provision/join/sleep are gone — a computer is not something
    // the user turns on.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // `ensure`, nie samo `status`: docker's restart policy handles a crashed
      // process, but a container that was stopped outright needs starting, and
      // the panel polls this route — so watching the computer is what heals it.
      // Idempotent, and a no-op when it is already up.
      const status = await ensureComputer();
      if (status.state !== "ready" && !(await dockerAvailable())) {
        return json(res, 200, {
          state: "error",
          detail: "Docker is not reachable — the bot's computer needs it to run.",
        });
      }
      return json(res, 200, { state: status.state, detail: status.detail, ...computerControl.control() });
    }

    // The screen. HTTP here, WebSocket via mountVncUpgrade.
    {
      const hit = matchVncRoute(path);
      if (hit && (method === "GET" || method === "HEAD")) {
        if (!store.bot(hit.botId)) return json(res, 404, { error: "no such bot" });
        await proxyVncHttp(req, res, hit.rest, url.search);
        return;
      }
    }

    // Input lease (H5). Screenshots are never gated — only typing and clicking.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/control$/);
    if (m && method === "GET") return json(res, 200, computerControl.control());
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/control\/(acquire|renew|release)$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const next = m[2] === "release" ? computerControl.release() : computerControl.acquire();
      if (m[2] === "release") broadcast({ kind: "computer-queue", ...computerControl.control() });
      broadcast({ kind: "computer", botId: m[1], state: next.owner === "user" ? "user-control" : "ready" });
      return json(res, 200, next);
    }

    // The bot's terminal. Same filesystem as its desktop and browser.
    //
    // A caller may know the bot only by its `mb-<threadId>` room id (the shape
    // group membership and the UI speak) — accept either identity.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/exec$/);
    if (m && method === "POST") {
      const asMemberThread = threadIdOfGroupMember(m[1]);
      const botId = store.bot(m[1])
        ? m[1]
        : (asMemberThread ? store.botByThread(asMemberThread)?.id : undefined);
      if (!botId) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const command = String(body.command ?? "");
      if (!command.trim()) return json(res, 400, { error: "command required" });
      try {
        return json(res, 200, { output: await computerExec(command) });
      } catch (e) {
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // packaged app: the server serves the built UI too (window → :8799 for
    // everything, no dev proxy to die). OMB_STATIC_DIR is set by Electron.
    if ((method === "GET" || method === "HEAD") && !path.startsWith("/api/") && STATIC_DIR) {
      const root = resolve(STATIC_DIR);
      const requested = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^[/\\]+/, "");
      const file = resolve(root, requested);
      if (file !== root && !file.startsWith(root + sep)) return json(res, 404, { error: "not found" });
      try {
        const data = readFileSync(file);
        res.writeHead(200, staticHeaders(file));
        return res.end(method === "HEAD" ? undefined : data);
      } catch {
        // SPA fallback
        try {
          const data = readFileSync(join(STATIC_DIR, "index.html"));
          res.writeHead(200, staticHeaders(join(STATIC_DIR, "index.html")));
          return res.end(method === "HEAD" ? undefined : data);
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
};

// Jeden serwer dla HTTP i dla WebSocketów. `https.Server` nie dziedziczy w
// typach po `http.Server` (choć w runtime jest tym samym serwerem HTTP), więc
// suma typów idzie aż do mountAuth/mountEventsWs/mountVncUpgrade — bez rzutowań.
const server: HttpServer | HttpsServer = TLS
  ? createHttpsServer({ key: TLS.keyPem, cert: TLS.certPem }, handleRequest)
  : createServer(handleRequest);

// multibot: `POST /webhooks/<id>` odpala rutynę webhookową. Siedzi PRZED
// bramką auth celowo: autoryzacją jest HMAC sekretu rutyny, nie token dostępu,
// bo adres webhooka podaje się obcym systemom. Owijamy listener, bo główny
// handler jedzie już za `mountAuth`.
{
  const app = server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    const hook = req.method === "POST"
      ? /^\/webhooks\/([^/]+)$/.exec(new URL(req.url ?? "/", "http://127.0.0.1").pathname)
      : null;
    if (!hook) return app(req, res);
    // `decodeURIComponent` rzuca na zepsutym escape'ie (`/webhooks/%zz`). Ta
    // trasa jest PRZED bramką auth, a listener nie ma nad sobą nikogo, kto by
    // to złapał — nieobsłużony wyjątek ubijał cały serwer. Zły escape to po
    // prostu nieznane id.
    let id: string | null = null;
    try {
      id = decodeURIComponent(hook[1]);
    } catch {
      id = null;
    }
    if (id === null) return json(res, 404, { error: "no such webhook" });
    void harnessWebhookInbound(req, res, id)
      .catch((error) => {
        console.warn("[multibot] webhook handler failed:", error instanceof Error ? error.message : error);
        if (!res.headersSent) json(res, 500, { error: "webhook failed" });
        return true;
      })
      .then((handled) => {
        if (!handled && !res.headersSent) json(res, 404, { error: "no such webhook" });
      });
  });
}
// Gniazdo, którego nie weźmie żaden z handlerów niżej, trzeba zamknąć samemu:
// Node sprząta automatycznie tylko wtedy, gdy listenerów `upgrade` NIE MA
// wcale. Robiła to dotąd przelotka silnika (destroy dla obcych ścieżek); bez
// tego każdy `Upgrade: websocket` na nieznany adres zostawiał otwarty
// deskryptor. Lista ścieżek jest jawna, więc kolejność montażu nic tu nie
// zmienia — obcy adres ginie, znany idzie dalej nietknięty.
server.on("upgrade", (req, socket: import("node:stream").Duplex) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (matchVncRoute(path) || path === "/api/events") return;
  if (!socket.destroyed) socket.destroy();
});
// multibot (H4): the bot's screen. Mounted before auth so one gate covers it.
mountVncUpgrade(server, (req, botId) => canReadBot(store.bot(botId), actorForRequest(req)));
// Kanał zdarzeń po WS — ta sama ścieżka co SSE, ta sama bramka auth (montaż
// przed `mountAuth`). Patrz `server/events-ws.ts`: tunel buforuje SSE.
mountEventsWs(server, (url, send, req) => {
  const lang = url.searchParams.get("lang");
  if (lang === "pl" || lang === "en") uiLang = lang;
  // Aktor raz na gniazdo, jak w SSE (`EventClient`): filtr ACL chodzi po każdej
  // ramce, a poświadczenie i tak nie zmienia się w trakcie życia socketa.
  // Unieważnienie sesji zrywa gniazdo przez `revokeAuthSessions`.
  const actor = actorForRequest(req);
  send(JSON.stringify({ kind: "hello" }));
  send(JSON.stringify({
    kind: "environment.snapshot",
    environment: fleetEnvironmentForActor(actor),
    sequence: ++eventSequence,
  }));
  return (text) => {
    try {
      return eventVisible(JSON.parse(text), actor);
    } catch {
      return false;
    }
  };
});

// Auth mounts after the WS upgrades so one wrapper covers harness HTTP and
// every WS upgrade path. Jedno poświadczenie: identity v2 (cookie sesji, token
// dostępu w nagłówku/subprotokole, `?token=` na ekranie komputera).
revokeAuthSessions = mountAuth(server, identityActorForRequest).revokeSessions;

// Tor last, so the onion ingress hands connections to a server that already has
// every wrapper on it. Started before `listen`: bootstrapping takes 10-30 s and
// nothing about the boot waits for it.
tor = startTor({
  dataDir: DATA_DIR,
  server,
  onionPort: PORT,
  // The hostname appears seconds after boot; without this nudge the badge would
  // wait out the ten-minute rescan tick before showing the address that works.
  onReady: () => void refreshAddress(PORT).catch(() => {}),
});

// multibot (H1): every bot has a computer, so boot makes that true again.
// Containers survive a harness restart on their own restart policy; this only
// heals what drifted (a bot created while docker was down, a container removed
// by hand). Orphans are reported, not reaped, unless they unambiguously belong
// to a bot that no longer exists.
async function reconcileComputers(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.warn("[multibot] docker unreachable — the bot computer will show as error until it is up");
    return;
  }
  // One computer for the whole installation: resume it if it exists, never
  // create one just because the harness started.
  await resumeComputer().catch(() => false);
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[multibot] port ${PORT} busy (EADDRINUSE) - another server on ${HOST}:${PORT} already running, refusing second instance`);
    process.exit(1);
  }
  throw err;
});
// A server that has never been joined configures itself here — before the first
// request can ask whether it is configured. Listening unconfigured would serve
// a box nobody can ever sign into, so a failure here is fatal.
try {
  await identity.ensureConfigured(primaryAddress(PORT), TLS_FINGERPRINT);
} catch (error) {
  console.error("[multibot] server self-configuration failed — refusing to start:", error);
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  console.log(`multibot server on ${SCHEME}://${HOST}:${PORT}`);
  if (TLS_FINGERPRINT) console.log(`[multibot] tls fingerprint (sha256): ${TLS_FINGERPRINT}`);
  void reconcileComputers().catch((e) => console.warn("[multibot] computer reconcile failed:", e));
  // multibot (A2): rozgrzewka rusza PO podniesieniu HTTP i nie czeka na nic —
  // serwer odpowiada od pierwszej sekundy, a workery wstają w tle.
  void warmBots().catch((e) => console.warn("[multibot] warmup failed:", e));
  // A conversation whose bots simply went quiet must still settle and report;
  // the wall clock cannot wait for the next message that may never come.
  // ponytail: jedno zamiatanie na minutę na CAŁĄ listę pokojów — pokojów są
  // dziesiątki, nie miliony; przy większej skali należy się kolejka terminów.
  setInterval(sweepExpiredRooms, Math.min(60_000, Math.max(1_000, collabMaxMs()))).unref?.();
  // A conversation cut off by a restart is not a failure — it is a turn that
  // never started. Anything still inside its budget and its clock is picked up
  // where it stopped; only the genuinely spent ones are written off.
  resumeRecoveredRooms();
  // multibot: w trybie „każdy bot zawsze active" worker potrafi zniknąć bez
  // naszego udziału — Android przy braku pamięci ubija bezczynne procesy (LMK),
  // a wtedy bot cicho wraca do zimnego startu. Co minutę sprawdzamy więc, kto
  // stracił proces, i stawiamy go z powrotem; warmBot jest idempotentny, więc
  // ciepłe boty zamiatanie nic nie kosztuje. Przy limicie > 0 nie zamiatamy
  // wcale — tam bezczynny worker MA prawo zejść i wskrzeszanie go co minutę
  // wywróciłoby WORKER_IDLE_MS na każdej domyślnej instalacji.
  if (warmWorkerLimit() <= 0) setInterval(() => void warmBots().catch(() => {}), 60_000).unref?.();
  // Never before `listen`: SSDP waits on a router that may never answer, and
  // nothing about the boot may depend on whether one does.
  void refreshAddress(PORT).catch(() => {});
  setInterval(() => void refreshAddress(PORT).catch(() => {}), 10 * 60_000).unref?.();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    harnessRoutines.stop();
    // Give the router its port back. Best effort by design: the exit below does
    // not wait for it, and a router that has gone away costs us nothing.
    void unmapPort().catch(() => {});
    // Our child, our job: a tor left behind keeps the data directory locked and
    // the NEXT harness would never get its onion back.
    tor?.stop();
    // taskkill /T is asynchronous on Windows. Exiting immediately abandoned
    // CLI children (and kept their profile files locked), so give it one
    // short reap window after all adapters requested disposal.
    void registry.disposeAll().finally(() => setTimeout(() => process.exit(0), process.platform === "win32" ? 500 : 0));
  });
}

function readBytes(req: IncomingMessage, max = MAX_FILE_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) return reject(Object.assign(new Error("body too large"), { status: 413 }));
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        req.resume();
        reject(Object.assign(new Error("body too large"), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}
