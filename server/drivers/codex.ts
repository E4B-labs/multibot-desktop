// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and falls back to a fresh thread/start.
import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { approvalRule } from "../approval-rules.ts";
import { augmentedPath, resolveCliSpawn } from "../env-path.ts";
import { AGENTS_TOOLS_VERSION } from "../turn-tools.ts";
import { COMPUTER_MCP_TOOLS } from "../turn-tools.ts"; // multibot (A4): whitelist narzędzi komputera
import { killTree } from "../kill-tree.ts";
import { approvalRuleAllowed, autoApproveAllowed, canUseIntegration, toolAllowed, turnPolicy } from "../turn-policy.ts";
import { appendNative } from "./native.ts";
import { historyBlock } from "./history.ts";
import { loadConfig } from "../config.ts";
import { connectors as userConnectors } from "../mcp-connectors.ts";

const DRIVER_KIND = "codex";

// catalog ported from upstream packages/contracts/src/model.ts
const MODELS = {
  default: "gpt-5.6-sol",
  options: [
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  ],
};

// Only the 5.6 line and GPT-6 Astra (03.09.2026) accept "max"; older models
// reject it, so the CLI gets "xhigh" instead. Composer.tsx mirrors this list —
// front and server live in separate tsconfig projects, so it stays duplicated.
export const supportsMaxReasoning = (model: string | undefined) =>
  !!model && (model === "gpt-6-astra" || model.startsWith("gpt-5.6-"));

/** multibot: „Fast mode" to codeksowy SERVICE TIER `priority` — w samym codeksie
 * (`/fast` w TUI) nazywa się „Fast", katalog modeli opisuje go jako „1.5x speed,
 * increased usage". Na subskrypcji ChatGPT NIE MA dopłaty w dolarach; płaci się
 * limitem planu: 2,5x stawki dla GPT-5.6/5.5 i 2x dla GPT-5.4
 * (https://learn.chatgpt.com/docs/agent-configuration/speed).
 *
 * Kto go ma, mówi `model/list` z app-servera: pole `serviceTiers`. Odpytane na
 * zalogowanym koncie ChatGPT 04.09.2026 (codex-cli 0.152.1) — `priority` mają
 * WSZYSTKIE modele poza `gpt-5.4-mini`, który wraca z pustą listą. Composer.tsx
 * powiela tę linię: front i serwer żyją w osobnych projektach tsconfig. */
export const supportsFastMode = (model: string | undefined) => !!model && model !== "gpt-5.4-mini";

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "MultiBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

// multibot (H3): Codex's mcp_servers carried only `agents`; the bot's computer
// has to ride along or Codex is the one driver that cannot touch the desktop
// the user is watching. Same stdio contract as every other server here.
export function codexMcpConfig(turn: SendTurnInput): {
  config?: { mcp_servers: Record<string, unknown>; features: Record<string, boolean> };
} {
  const mcp_servers: Record<string, unknown> = {};
  if (turn.integrations?.agents) mcp_servers.agents = turn.integrations.agents;
  if (turn.integrations?.web && canUseIntegration(turn.threadId, "browser")) mcp_servers.web = turn.integrations.web;
  // `required` — bez tego bot bywa BEZ komputera, cicho i losowo.
  //
  // Codex startuje serwery MCP równolegle z turą i kompletuje listę narzędzi w
  // momencie `resolve_for_step`. Serwer, który do tej chwili nie wstał, jest
  // POMIJANY, jeśli nie jest wymagany — w logu `omitting pending optional MCP
  // server server_name=computer`. Zmierzone, gdy ten serwer był Pythonem (mcp +
  // pydantic + fastmcp) i wstawał ~4 s: 46 tur z rzędu poszło bez komputera, a
  // bot uczciwie meldował, że komputera nie ma. Dziś serwer jest node'owy i
  // wstaje od razu, ale `required` zostaje: cicha degradacja jest tą samą
  // awarią niezależnie od czasu startu. Łaska dla
  // serwerów opcjonalnych to stała w kodzie codeksa (`OPTIONAL_MCP_STARTUP_
  // GRACE`), więc podnieść jej się nie da — jedyną dźwignią jest `required`.
  //
  // Cena: gdy serwer NIE wstanie, codex kończy sesję błędem zamiast puścić turę
  // bez komputera. Świadomie, bo cicha degradacja to dokładnie ta awaria, którą
  // tu naprawiamy — a `engineComputer()` i tak wcześniej sprawdza venv i silnik,
  // więc do tego miejsca dochodzi tylko komputer, który ma czym wstać.
  // Serwer `agents` jest node'owy, wstaje od razu i wyścigu nie przegrywa —
  // sprawdzone w logach codeksa (logs_2.sqlite): 46 pominięć `omitting pending
  // optional MCP server`, WSZYSTKIE `server_name=computer`, zero dla `agents`.
  // Zostaje opcjonalny: `required` dodałby ryzyko wywrócenia tury bez zysku.
  if (turn.integrations?.localComputer) {
    mcp_servers.computer = {
      ...turn.integrations.localComputer,
      required: true,
      // multibot (A4): komputer bota to jego WŁASNY sandbox (wspólny pulpit,
      // akcje nie ruszają hosta), więc nie pytamy o każdy tool z osobna.
      // `default_tools_approval_mode: "auto"` omija elicitation w codexie —
      // bez tego każdy screenshot/click/navigate czeka na aprobatę, a brak
      // odpowiedzi po 15 min kończył się cichym "user rejected" (sprawdzone:
      // fail screenshot w smoke i tura, w której bot nie nawigował, bo każdy
      // krok wisiał na aprobacie). Shell/edit na HOŚCIE dalej idą przez
      // zwykły approval policy — to nie jest obejście turn-policy.
      default_tools_approval_mode: "auto",
      // Jawna whitelist (mirror COMPUTER_MCP_TOOLS) — codex rejestruje tylko
      // te narzędzia; to samo źródło, z którego prompt wylicza ofertę tury.
      enabled_tools: [...COMPUTER_MCP_TOOLS],
      // Serwer jest dziś node'owy (`server/computer/mcp.ts`) i wstaje od razu —
      // zapas zostaje na wolny dzień telefonu, zanim required:true skończy turę
      // błędem. Kosztuje tylko wtedy, gdy naprawdę nie wstaje.
      startup_timeout_ms: 30_000,
    };
  }
  // multibot: Composio (meta-MCP HTTP) — boty codexowe go nie dostawały, bo
  // codexMcpConfig przekazywał tylko agents + computer. Claude owszem (przez
  // mcpServers()), codex nie, więc przy codexie Composio/Gmail milczały.
  // Codex chce kształt HTTP bez pola `type` (wykrywa po `url`) i wysyła
  // nagłówki z `http_headers` — nie z `headers` (to format Claude'a).
  if (turn.integrations?.composio?.key) {
    mcp_servers.composio = {
      url: turn.integrations.composio.url || "https://connect.composio.dev/mcp",
      http_headers: { "x-consumer-api-key": turn.integrations.composio.key },
    };
  }
  // multibot (F7): własne konektory MCP użytkownika — te same co u Claude'a.
  // Codex gubił je (przekazywał tylko agents + computer + composio), więc boty
  // codexowe nie widziały firmowych serwerów MCP. Kształt: stdio 1:1, HTTP przez
  // `url` + `http_headers` (nie `type`/`headers` jak Claude).
  if (canUseIntegration(turn.threadId, "integrations")) {
    for (const c of userConnectors(loadConfig())) {
      if (c.transport.type === "stdio") {
        mcp_servers[c.id] = {
          command: c.transport.command,
          args: c.transport.args ?? [],
          env: c.transport.env ?? {},
        };
      } else {
        mcp_servers[c.id] = {
          url: c.transport.url,
          ...(c.transport.headers ? { http_headers: c.transport.headers } : {}),
        };
      }
    }
  }
  // multibot: bez tego bot Z ZAMONTOWANYM komputerem meldował „BRAK-NARZĘDZI".
  //
  // codex 0.153.3 jedzie z włączoną (serwerowo) flagą
  // `ToolSearchAlwaysDeferMcpTools`: narzędzia MCP nie idą do modelu w liście
  // narzędzi, tylko czekają na doładowanie przez `tool_search`. Feature
  // `ToolSearch` NIE jest przy tym włączony — model nie dostaje ani narzędzi,
  // ani niczego, czym mógłby je znaleźć. Efekt: WSZYSTKIE serwery MCP tury
  // (computer, agents, tasktree, composio, web) znikają naraz, a bot uczciwie
  // odpowiada, że narzędzi nie ma. Mierzone na telefonie (s10e, codex-cli
  // 0.153.3): świeży wątek z jednym serwerem `computer` wołał
  // `mcp__computer__status` naprawdę, ten sam wątek z pełnym zestawem serwerów
  // odpowiadał „UNAVAILABLE".
  //
  // Przełącznik wyłącza samo odkładanie, więc narzędzia wracają do listy —
  // jedno pole w tym samym bloku `config`, którym i tak wieziemy serwery.
  return Object.keys(mcp_servers).length
    ? { config: { mcp_servers, features: { tool_search_always_defer_mcp_tools: false } } }
    : {};
}

// multibot (H3): serwery MCP wchodzą do wątku codeksa przy `thread/start` i
// `thread/resume` ich NIE dokłada — wątek założony, zanim bot dostał komputer,
// zostaje bez `computer` na zawsze (sprawdzone: świeży wątek woła `navigate`,
// wznowiony odpowiada "nie mam takiego narzędzia"). Dlatego zestaw serwerów
// jedzie w kursorze: zmienił się — wątek zaczyna się od nowa.
//
// ponytail: kursor jako `<id>#<serwery>` zamiast osobnego magazynu — kontrakt
// `resumeCursors` (string) zostaje bez zmian. Ceną była utrata pamięci po
// stronie codeksa przy każdej zmianie zestawu (i przy każdym bumpie
// AGENTS_TOOLS_VERSION) — to bolało, więc świeży wątek dostaje teraz
// `turn.transcript` w pierwszej turze (patrz `historyBlock` w ./history.ts).
/** Wersja zestawu narzędzi komputera bota, wpisywana w klucz kursora Codeksa.
 * PODNIEŚ przy KAŻDEJ zmianie `TOOLS` w `server/computer/mcp.ts` — codex trzyma
 * listę narzędzi w wątku, a `thread/resume` jej nie odświeża.
 *
 * 5 → 6: serwer MCP komputera wrócił z silnika Hermesa do harnessu
 * (`server/computer/mcp.ts`). Nazwy narzędzi te same, ale opisy i kształt
 * odpowiedzi nie — wątek sprzed usunięcia silnika musi zacząć od nowa.
 *
 * 6 → 7: wątki założone między 0.3.36 a tą poprawką powstały BEZ widocznych
 * narzędzi MCP (patrz `tool_search_always_defer_mcp_tools` w `codexMcpConfig`),
 * a `thread/resume` narzędzi nie dokłada — bez tego podbicia bot z zepsutym
 * wątkiem wznawiałby go bez komputera już na zawsze. */
export const COMPUTER_TOOLS_VERSION = 7;

export function cursorMcpKey(cfg: ReturnType<typeof codexMcpConfig>): string {
  return Object.keys(cfg.config?.mcp_servers ?? {})
    // Codex zapamiętuje w wątku także LISTĘ narzędzi serwera, nie tylko sam
    // serwer — dlatego OBA nasze serwery wchodzą do klucza z wersją swojego
    // zestawu. Komputer miał to od początku, agents nie miał: `send_file`
    // doszło do jego listy, klucz się nie zmienił, wątki zostały wznowione ze
    // starym zestawem i boty odpowiadały „nie mam takiego narzędzia".
    .map((name) => {
      if (name === "computer") return `computer@${COMPUTER_TOOLS_VERSION}`;
      if (name === "agents") return `agents@${AGENTS_TOOLS_VERSION}`;
      return name;
    })
    .sort()
    .join(",");
}

/** `<codexThreadId>#<serwery>` → części. Stary kursor (bez `#`) ma pusty zestaw,
 *  więc pierwsza tura z komputerem świadomie zakłada nowy wątek. */
export function splitCursor(cursor: string): { threadId: string; mcpKey: string } {
  const at = cursor.lastIndexOf("#");
  return at < 0 ? { threadId: cursor, mcpKey: "" } : { threadId: cursor.slice(0, at), mcpKey: cursor.slice(at + 1) };
}

/**
 * Co zrobić z kursorem przy tym zestawie serwerów: wznowić wątek czy zacząć nowy,
 * i jaki zestaw zapisać z powrotem.
 *
 * Restart TYLKO wtedy, gdy tura wnosi serwer, którego wątek nie zna — bo tylko
 * takiego `thread/resume` nie dołoży. W drugą stronę (komputer chwilowo nie
 * wstał, więc tura ma mniej serwerów) wątek zostaje: on ma komputer
 * zamontowany, a nieudany spawn psuje jedną turę, nie całą pamięć bota. Zapis
 * zostaje przy szerszym zestawie, żeby kolejna czkawka nie kasowała wątku.
 */
export function cursorPlan(
  storedCursor: unknown,
  mcpKey: string,
): { resume: string | null; key: string } {
  if (typeof storedCursor !== "string" || !storedCursor) return { resume: null, key: mcpKey };
  const stored = splitCursor(storedCursor);
  const known = new Set(stored.mcpKey ? stored.mcpKey.split(",") : []);
  const wanted = mcpKey ? mcpKey.split(",") : [];
  if (wanted.some((name) => !known.has(name))) return { resume: null, key: mcpKey };
  return { resume: stored.threadId, key: stored.mcpKey };
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => void;
      turnId: string;
      asks: Map<string, (behavior: string, message?: string) => void>;
      steer: (text: string) => Promise<"accepted" | "unavailable">;
    }
    const active = new Map<string, Turn>();
    // multibot: Codex raportuje NARASTAJĄCĄ sumę tokenów wątku i robi to
    // wielokrotnie w trakcie tury, a workspace.recordTokens DODAJE każdy
    // raport — bez delty licznik zużycia rósł lawinowo (suma sum).
    const reportedUsage = new Map<string, { input: number; output: number }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const policy = turnPolicy(threadId);
      const fullAuto = policy ? policy.autonomy === "autonomous" && !Object.values(policy.permissions).includes(false) : config.fullAuto;
      const turnId = newId();
      const requestedReasoning = (turn as SendTurnInput & { reasoning?: string }).reasoning;
      const effort = requestedReasoning === "max" && !supportsMaxReasoning(turn.model) ? "xhigh" : requestedReasoning;
      // multibot: `serviceTierForTurn`, nie `serviceTier` — ten drugi zapisuje
      // tier w USTAWIENIACH wątku codeksa, więc po wyłączeniu przełącznika wątek
      // dalej chodziłby na `priority` (każda tura wznawia wątek przez
      // `thread/resume`). Wersja „ForTurn" nie dotyka wątku, więc wyłączenie
      // naprawdę wyłącza, a brak pola zostawia to, co ma user w config.toml.
      const fastMode = (turn as SendTurnInput & { fastMode?: boolean }).fastMode === true && supportsFastMode(turn.model);

      const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
      // the CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal)
      delete env.OPENAI_API_KEY;

      const cli = resolveCliSpawn(config.cli, ["app-server"]); // multibot
      const child = spawn(cli.command, cli.args, {
        cwd: turn.cwd ?? homedir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: cli.windowsVerbatimArguments,
        detached: true,
      });

      const state = { settled: false, lastText: "", sawStreamDelta: false };
      const asks = new Map<string, (behavior: string, message?: string) => void>();
      let codexThreadId: string | null = null;
      let providerTurnId: string | null = null;
      let cancelled = false;
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          rpcPending.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method, params });
        });

      let cancelFallback: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (state.settled || cancelled) return;
        cancelled = true;
        if (codexThreadId && providerTurnId) {
          void request("turn/interrupt", { threadId: codexThreadId, turnId: providerTurnId }).catch(() => {});
          cancelFallback = setTimeout(() => settle(true, "cancelled"), 1500);
          cancelFallback.unref?.();
        } else {
          settle(true, "cancelled");
        }
      };

      /** multibot: `turn/steer` — tekst wpada do TRWAJĄCEJ tury, bez drugiej
       * tury i bez zabijania procesu (kończy ją dalej samo `turn/completed`).
       * `expectedTurnId` to warunek po stronie codeksa: gdy tura już nie jest ta
       * sama (skończyła się, `/review`, `/compact` → `activeTurnNotSteerable`),
       * żądanie PADA zamiast dostarczyć tekst gdzie indziej — i tylko dlatego
       * wyścig „steer kontra zakończenie" ma jedną ścieżkę dostarczenia.
       * Odpowiedź niesie `turnId` tury, która wchłonęła tekst — zapamiętujemy
       * go, żeby kolejny steering nie celował w nieaktualne id. */
      const steer = async (text: string): Promise<"accepted" | "unavailable"> => {
        if (state.settled || cancelled || !codexThreadId || !providerTurnId) return "unavailable";
        try {
          const result = await request("turn/steer", {
            threadId: codexThreadId,
            expectedTurnId: providerTurnId,
            input: [{ type: "text", text }],
          });
          if (typeof result?.turnId === "string") providerTurnId = result.turnId;
          return "accepted";
        } catch {
          return "unavailable";
        }
      };

      const settle = (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        if (cancelFallback) clearTimeout(cancelFallback);
        for (const finish of [...asks.values()]) finish("deny", "MultiBot: the turn ended");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
        killTree(child); // the per-turn app-server never exits on its own
      };

      // server→client approval request → canonical request.opened
      const handleServerRequest = (msg: any) => {
        if (state.settled) return;
        const method = msg.method as string;
        const params = msg.params ?? {};
        const isMcpElicitation = method === "mcpServer/elicitation/request";
        if (isMcpElicitation) {
          const serverName = String(params.serverName || "mcp");
          const tool = `mcp__${serverName}`;
          const remembered = approvalRule(DRIVER_KIND, tool, {});
          const reply = (action: "accept" | "decline" | "cancel") => send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { action, content: action === "accept" ? {} : null },
          });
          if (!toolAllowed(threadId, tool)) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: `${tool} blocked by bot permissions` });
            return reply("decline");
          }
          if (autoApproveAllowed(threadId, tool) || approvalRuleAllowed(threadId, remembered)) return reply("accept");

          const requestId = newId();
          const finish = (behavior: string) => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const allowed = behavior === "allow" || behavior === "always";
            reply(allowed ? "accept" : "decline");
            emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source: "user" });
          };
          const timer = setTimeout(() => finish("deny"), 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary: String(params.message ?? params._meta?.tool_description ?? tool).slice(0, 200),
            approvalRule: remembered,
          });
          return;
        }
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        const isQuestion = method === "item/tool/requestUserInput";
        const tool =
          method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isQuestion
              ? "ask_user"
              : "shell";
        const nativeRule = params.proposedExecpolicyAmendment ?? params.proposedExecPolicyAmendment ?? params.execpolicyAmendment;
        const remembered = approvalRule(DRIVER_KIND, tool, { command: params.command }, nativeRule);
        const persistentDecision = Array.isArray(nativeRule)
          ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: nativeRule } }
          : "acceptForSession";
        if (!isQuestion && !toolAllowed(threadId, tool)) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: `${tool} blocked by bot permissions` });
          return send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { decision: legacy ? "denied" : "decline" },
          });
        }
        if (!isQuestion && (autoApproveAllowed(threadId, tool) || (!policy && config.fullAuto))) {
          return send({ jsonrpc: "2.0", id: msg.id, result: { decision: legacy ? "approved" : "accept" } });
        }
        if (!isQuestion && approvalRuleAllowed(threadId, remembered)) {
          return send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { decision: legacy ? "approved" : persistentDecision },
          });
        }
        const requestId = newId();
        const summary =
          typeof params.command === "string"
            ? params.command.slice(0, 200)
            : Array.isArray(params.questions)
              ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
              : typeof params.reason === "string"
                ? params.reason
                : tool;
        const choices = isQuestion
          ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
          : undefined;
        const finish = (behavior: string, message?: string) => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
            }
            send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
          } else {
            const allowed = behavior === "allow" || behavior === "always";
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                decision: allowed
                  ? legacy
                    ? "approved"
                    : behavior === "always"
                      ? persistentDecision
                      : "accept"
                  : legacy ? "denied" : "decline",
              },
            });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source: "user" });
        };
        const timer = setTimeout(
          () => (isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE) : finish("deny", DENY_TIMEOUT_NOTE)),
          15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          summary,
          choices,
          ...(!isQuestion ? { approvalRule: remembered } : {}),
        });
      };

      const handleNotification = (msg: any) => {
        if (state.settled) return;
        const p = msg.params ?? {};
        switch (msg.method) {
          // token-level chat text; the item/completed frame follows with the
          // whole message, so its delta is only a fallback when none streamed
          case "item/agentMessage/delta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            }
            break;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            break;
          }
          case "item/started": {
            const item = p.item ?? {};
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell").slice(0, 80)
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (item.tool ?? item.name ?? "mcp")
                    : item.type === "webSearch"
                      ? "web_search"
                      : null;
            if (title) emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: item.id, title });
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined",
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            const t = p.tokenUsage?.total;
            if (t) {
              // suma → delta względem ostatniego raportu tego wątku; ujemna
              // (nowa sesja po restarcie CLI zaczyna sumę od zera) = pełna suma
              const prev = reportedUsage.get(threadId) ?? { input: 0, output: 0 };
              const totalInput = t.inputTokens ?? 0;
              const totalOutput = t.outputTokens ?? 0;
              const input = totalInput >= prev.input ? totalInput - prev.input : totalInput;
              const output = totalOutput >= prev.output ? totalOutput - prev.output : totalOutput;
              reportedUsage.set(threadId, { input: totalInput, output: totalOutput });
              if (input || output) {
                emit({
                  ...base(threadId, turnId),
                  type: "thread.token-usage.updated",
                  input,
                  output,
                });
              }
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            if (cancelled || t.status === "interrupted") settle(true, "cancelled");
            else settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            if (p.message) emit({ ...base(threadId, turnId), type: "runtime.error", message: p.message });
            break;
        }
      };

      let buf = "";
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", message: `spawn failed: ${e.message}` });
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (!state.settled) {
          if (cancelled) return settle(true, "cancelled");
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, { stop, turnId, asks, steer });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; any refusal surfaces as failure, not a hang
      (async () => {
        try {
          await request("initialize", { clientInfo: { name: "multibot", version: "1" } });
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          const mcpConfig = codexMcpConfig(turn);
          const mcpKey = cursorMcpKey(mcpConfig);
          const plan = cursorPlan(turn.resumeCursor, mcpKey);
          const cursor = plan.resume;
          let startedModel: string | null = null;
          let didResume = false;
          // multibot: sandbox + approvalPolicy MUSZĄ jechać także w `thread/resume`.
          // Codex 0.153 nie odtwarza polityki piaskownicy wznawianego wątku z dysku
          // — bez tego pola wątek wraca na domyślne `workspace-write`, a w piaskownicy
          // 0.153 KAŻDE wywołanie narzędzia MCP wymaga aprobaty; przy
          // `approvalPolicy: "never"` codex odmawia zamiast zapytać i tura dostaje
          // `MCP tool call requires approval, but approval policy is never`.
          // Pierwsza tura (thread/start) działała, każda następna (resume) nie —
          // czyli create_reminder/notify_user/list_routines/send_bot_mail padały
          // w produkcji. Zmierzone na telefonie (codex-cli 0.153.3): resume bez
          // `sandbox` = błąd aprobaty, resume z `sandbox` = narzędzie wchodzi;
          // sam `approvalPolicy` nie wystarcza.
          const threadSettings = {
            sandbox: fullAuto ? "danger-full-access" : policy?.permissions.file === false ? "read-only" : "workspace-write",
            approvalPolicy: fullAuto ? "never" : "on-request",
          } as const;
          if (cursor) {
            try {
              const resumed = await request("thread/resume", {
                threadId: cursor,
                ...threadSettings,
                ...mcpConfig,
              });
              codexThreadId = resumed?.thread?.id ?? cursor;
              didResume = true;
            } catch {
              /* resume unsupported or thread gone — start fresh below */
            }
          }
          if (!codexThreadId) {
            const started = await request("thread/start", {
              cwd: turn.cwd ?? homedir(),
              model: turn.model || null,
              ...threadSettings,
              ephemeral: false,
              ...mcpConfig,
              ...(turn.system ? { instructions: turn.system } : {}),
            });
            codexThreadId = started?.thread?.id ?? null;
            startedModel = started?.model ?? null;
          }
          emit({
            ...base(threadId, turnId),
            type: "session.started",
            // bez serwerów MCP kursor zostaje gołym id — tak wygląda od zawsze
            sessionId: codexThreadId && plan.key ? `${codexThreadId}#${plan.key}` : codexThreadId,
            model: startedModel ?? turn.model ?? null,
          });
          // Nowy wątek codeksa = pusty kontekst. Rozmowa jest na dysku harnessu,
          // więc dokładamy ją JEDEN raz, w pierwszej turze tej sesji.
          const replay = didResume ? "" : historyBlock(turn.transcript);
          const turnInput = [
            ...(turn.system ? [{ type: "text", text: `SYSTEM — MultiBot identity and rules (highest priority, overrides any base ChatGPT/Claude identity):\n${turn.system}` }] : []),
            ...(replay ? [{ type: "text", text: replay }] : []),
            { type: "text", text: turn.text },
            ...(turn.attachments ?? []).filter((file) => file.mime.startsWith("image/")).map((file) => ({ type: "localImage", path: file.path })),
          ];
          const startedTurn = await request("turn/start", {
            threadId: codexThreadId,
            input: turnInput,
            ...(effort ? { effort } : {}),
            ...(fastMode ? { serviceTierForTurn: "priority" } : {}),
          });
          providerTurnId = startedTurn?.turn?.id ?? startedTurn?.turnId ?? null;
        } catch (e) {
          if (!state.settled) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            settle(false, "rpc_error");
          }
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const probe = (args: string[]) => new Promise<{ ok: boolean; output: string }>((resolve) => {
        const cli = resolveCliSpawn(config.cli, args); // multibot
        execFile(
          cli.command,
          cli.args,
          {
            timeout: 8000,
            env: { ...process.env, PATH: augmentedPath() },
            windowsVerbatimArguments: cli.windowsVerbatimArguments,
          },
          (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.trim() }),
        );
      });
      const version = await probe(["--version"]);
      if (!version.ok || !version.output) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const auth = await probe(["login", "status"]);
      return { state: "available", version: version.output, authenticated: auth.ok };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported", agentsMcp: true, webTools: "mcp", steering: "same-turn" },
        sendTurn,
        steerTurn: async (threadId, text) => (await active.get(threadId)?.steer(text)) ?? "unavailable",
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const turn = active.get(threadId);
          const finish = turn?.asks.get(requestId);
          if (!finish) throw new Error("no such pending request");
          finish(decision.behavior, decision.message);
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        listeners.clear();
      },
    };
  },
};
