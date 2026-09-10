// Claude driver — stream-json both directions. One worker stays alive per
// bot, so Termux/proot and MCP handshakes happen once instead of per turn.
//
// Integrations become MCP servers on the CLI:
//   - Composio Connect (connected apps → tools) over streamable HTTP
//   - the bot's cloud computer (box.ascii.dev) via server/computer-proxy.ts
//     — screenshot/exec/open_url, the CUA-on-the-box bridge
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "../config.ts";
import { augmentedPath, resolveCliSpawn } from "../env-path.ts";
// multibot (F7): wspólny montaż mcpServers (Composio + własne konektory).
import { mcpServers as buildMcpServers } from "../mcp-servers.ts";
import { killTree } from "../kill-tree.ts";
import { approvalRule } from "../approval-rules.ts";
import { staleCliNotice } from "../cli-update.ts";
import { approvalRuleAllowed, autoApproveAllowed, canUseIntegration, toolAllowed, turnPolicy } from "../turn-policy.ts";

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
import { appendNative } from "./native.ts";
import { historyBlock } from "./history.ts";

const DRIVER_KIND = "claudeAgent";

export interface ClaudeConfig {
  cli: string;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
}

// model catalog ported from upstream packages/contracts/src/model.ts
const MODELS = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-fable-5-1", label: "Fable 5.1" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
};

// UI keeps stable product names; Claude Code receives official model IDs.
const canonicalModel = (model: string | undefined) => {
  if (!model || model === "sonnet" || model.startsWith("claude-sonnet-")) return "claude-sonnet-5";
  if (model === "opus" || model.startsWith("claude-opus-")) return "claude-opus-5";
  if (model === "haiku" || model.startsWith("claude-haiku-")) return "claude-haiku-4-5";
  if (model === "fable" || model.startsWith("claude-fable-")) return "claude-fable-5-1";
  return model;
};
const cliModel = (model: string | undefined) => {
  return canonicalModel(model);
};

// multibot: ciepła sesja odpowiada w ~1.7 s, zimny start CLI na telefonie pod
// obciążeniem kosztował 83 s — o szybkości bota decyduje więc to, czy proces
// jeszcze żyje, a nie jaki model i ile myśli. Stąd godzina bezczynności zamiast
// dziesięciu minut. Telefon nie ma RAM-u na proces per wątek, więc liczbę
// żywych workerów ogranicza LRU (reapWarmWorkers) — ciepły zostaje ten, z kim
// użytkownik faktycznie rozmawia.
// Godzina to dokładnie ten przypadek, na który skarżył się użytkownik („także po
// godzinie ciszy"), więc okno idzie na pół doby. Nie kosztuje to niczego, bo
// pamięć ogranicza już LRU niżej, a nie zegar: żywych procesów jest tyle samo,
// tylko czekają na rozmowę dłużej. Zmierzone na s10e: tura po ciszy 70–72 s do
// pierwszego tokena (dwa boty), ta sama tura na ciepłym workerze 4 s.
const WORKER_IDLE_MS = Number(process.env.MULTIBOT_WORKER_IDLE_MS) || 12 * 60 * 60_000;
// multibot: MULTIBOT_WARM_WORKERS=0 włącza tryb „każdy bot to ciepły worker" —
// nie eksmitujemy nikogo i nie ubijamy nikogo z bezczynności, bo każdy bot ma
// odpowiadać w kilka sekund także po dobie ciszy. Gdy zmiennej nie ma, zostaje
// dawne 2: instalacje, które o nic nie prosiły, nie mają nagle trzymać
// dziesięciu procesów CLI naraz. Czytane przy każdej turze, nie przy imporcie —
// test podkręca wartość bez przeładowywania modułu.
// UWAGA: server/index.ts parsuje tę samą zmienną tak samo (warmBots) — obie
// strony muszą rozumieć 0 identycznie, inaczej rozgrzewamy dwa boty, a limitu
// nie ma.
const maxWarmWorkers = () =>
  process.env.MULTIBOT_WARM_WORKERS ? Number(process.env.MULTIBOT_WARM_WORKERS) || 0 : 2;

// multibot (B): budżet na PIERWSZY znak życia procesu po wysłaniu tury — nie na
// całą turę (długie tury są legalne i nie wolno ich ucinać). Ciepły worker
// odzywa się na s10e w 3–4 s, więc 20 s to szeroki zapas; świeżo postawiony ma
// najpierw przejść zimny start CLI (zmierzone ~9 s na spokojnym telefonie,
// kilkadziesiąt pod obciążeniem) plus handshake serwerów MCP — stąd 120 s.
// Czytane przy każdej turze, nie przy imporcie — test ma je podkręcić bez
// przeładowywania modułu.
const firstEventMs = (freshSpawn: boolean) =>
  freshSpawn
    ? Number(process.env.MULTIBOT_FIRST_EVENT_COLD_MS) || 120_000
    : Number(process.env.MULTIBOT_FIRST_EVENT_MS) || 20_000;

// proxy entry files live next to this one as .ts in dev (node type
// stripping) and .js in the compiled dist-server the packaged app ships
const proxyPath = (basename: string) => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "..", `${basename}.ts`);
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
};
const PROXY_PATH = proxyPath("computer-proxy");
const PERM_PROXY_PATH = proxyPath("permission-proxy");
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

// multibot: zimny start CLI na telefonie kosztował 59 s, z czego 30 s to sam
// czas jądra. Powód zmierzony `strace -c`: Claude Code przy starcie przechodzi
// pętlą po CAŁEJ tablicy deskryptorów — 196 470 nieudanych `fcntl()` przy
// RLIMIT_NOFILE = 32768 (sześć przebiegów po 32768). W Termuksie CLI chodzi pod
// prootem, gdzie KAŻDY syscall to przystanek ptrace, więc ta pętla rośnie
// liniowo z limitem: 256 → 8,1 s, 1024 → 9,8 s, 4096 → 13,3 s, 32768 → 59 s.
// Zbijamy limit do klasycznych 1024 — CLI trzyma kilkanaście deskryptorów, a
// serwery MCP to osobne procesy z własnymi limitami, więc niczego to nie ucina.
// `ulimit` obniża limit miękki, na co nie trzeba uprawnień; gdyby się nie udało,
// błąd idzie do kosza i proces startuje jak dotąd.
const CLI_NOFILE = Number(process.env.MULTIBOT_CLI_NOFILE) || 1024;
type ResolvedSpawn = ReturnType<typeof resolveCliSpawn>;
function cliSpawn(cli: string, args: string[]): ResolvedSpawn {
  const resolved = resolveCliSpawn(cli, args);
  // Windows nie ma ulimitu ani problemu — tam zostaje wywołanie jak dotąd.
  if (process.platform === "win32") return resolved;
  // Keep an explicitly missing path visible to Node so the child emits its
  // `error` event. Wrapping it in /bin/sh would turn ENOENT into exit 127 and
  // incorrectly report `exit_before_result` instead of `spawn_error`.
  if (/[\\/]/.test(resolved.command) && !existsSync(resolved.command)) return resolved;
  return {
    ...resolved,
    command: "/bin/sh",
    args: ["-c", `ulimit -n ${CLI_NOFILE} 2>/dev/null; exec "$0" "$@"`, resolved.command, ...resolved.args],
  };
}

// ── permission broker (ported from agentcal drivers/claude.js) ─────────
// A headless run that hits a permission acceptEdits doesn't cover should
// neither stall silently NOR get blanket-denied — it should ask the user.
// The broker is a net server on a per-turn socket; the proxy (spawned by
// the claude CLI) forwards asks over it and waits. Unanswered permission
// asks deny after timeoutMs with a keep-moving note; unanswered questions
// answer with "use your best judgment" — guidance, never a block.
interface Ask {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  at: number;
}

const DENY_TIMEOUT_NOTE =
  "MultiBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "MultiBot: nobody answered in time. Use your best judgment and continue.";
const QUESTION_DISMISS_NOTE = "MultiBot: the user closed the question without answering. Use your best judgment and continue.";

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  const input = ask.input ?? {};
  if (typeof input.question === "string") return input.question.slice(0, 300);
  if (typeof input.command === "string") return input.command.slice(0, 200);
  if (typeof input.url === "string") return input.url.slice(0, 200);
  const text = JSON.stringify(input);
  return text === "{}" ? (ask.tool ?? "tool") : text.slice(0, 200);
}

export function permissionSocketPath(threadId: string) {
  const tag = threadId.replace(/[^\w-]/g, "").slice(0, 8);
  // multibot: Windows has no unix sockets — net.createServer binds a named
  // pipe instead, same API on both ends. The pipe namespace is global and
  // flat (DATA_DIR does not isolate it), so the pid keeps concurrent
  // harnesses off each other's names.
  if (process.platform === "win32") return `\\\\.\\pipe\\multibot-perm-${process.pid}-${tag}`;
  return join(DATA_DIR, `perm-${tag}.sock`);
}

function createPermissionBroker(opts: {
  socketPath: string;
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: string; source: string }) => void;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pending = new Map<string, { ask: Ask; finish: (behavior: string, message: string | undefined, source: string) => void }>();
  try {
    unlinkSync(opts.socketPath);
  } catch {}
  const server = createNetServer((conn) => {
    conn.on("error", () => {});
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t !== "ask") continue;
        const askId = String(msg.id ?? newId());
        const kind = msg.kind === "question" ? ("question" as const) : ("permission" as const);
        const ask: Ask = {
          id: askId,
          kind,
          tool: msg.tool ?? "tool",
          input: msg.input ?? {},
          suggestions: Array.isArray(msg.suggestions) ? msg.suggestions : undefined,
          at: Date.now(),
        };
        const finish = (behavior: string, message: string | undefined, source: string) => {
          if (!pending.delete(askId)) return;
          clearTimeout(timer);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior, message }) + "\n");
          } catch {}
          opts.onResolve({ ...ask, behavior, source });
        };
        const timer = setTimeout(
          () =>
            kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
          timeoutMs,
        );
        timer.unref?.();
        pending.set(askId, { ask, finish });
        opts.onAsk(ask);
      }
    });
  });
  // multibot: a broker that never came up used to be silent — every
  // approval then timed out into a deny nobody could explain. Say so.
  server.on("error", (e) => {
    console.error(`permission broker unavailable on ${opts.socketPath}: ${(e as Error).message}`);
  });
  server.listen(opts.socketPath);
  return {
    answer(askId: string, behavior: string, message?: string): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      // multibot: pytanie ma tylko jedną formę odpowiedzi — treść. Zamknięcie
      // karty krzyżykiem przychodzi jako "deny" i wypadało tu na `false`: ask
      // zostawał w `pending`, karta znikała z czatu, a bot wisiał do
      // 15-minutowego timeoutu i sam sobie dopisywał odpowiedź. Każde
      // rozstrzygnięcie pytania kończymy więc jako odpowiedź.
      if (p.ask.kind === "question") {
        p.finish("answer", message ?? QUESTION_DISMISS_NOTE, "user");
        return true;
      }
      if (!["allow", "always", "deny"].includes(behavior)) return false;
      p.finish(behavior, message, "user");
      return true;
    },
    close() {
      for (const p of [...pending.values()]) {
        if (p.ask.kind === "question") p.finish("answer", "MultiBot: the turn is ending — wrap up.", "shutdown");
        else p.finish("deny", "MultiBot: the turn ended", "shutdown");
      }
      try {
        server.close();
      } catch {}
      try {
        unlinkSync(opts.socketPath);
      } catch {}
    },
  };
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.permissionMode;
  if (mode !== undefined && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  return {
    cli: typeof o.cli === "string" ? o.cli : "claude",
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
  };
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    type Broker = ReturnType<typeof createPermissionBroker>;
    type Turn = { turnId: string; broker?: Broker; settled: boolean; sawStreamDelta: boolean };
    type Worker = {
      child: ReturnType<typeof spawn>;
      signature: string;
      sessionId: string | null;
      /** multibot: proces wstał BEZ `--resume`, więc nie zna rozmowy — pierwsza
       *  prawdziwa tura tej sesji dostaje historię wątku z dysku harnessu.
       *  Osobne pole, nie zmienna lokalna, bo rozgrzewka (`warmOnly`) stawia
       *  proces bez tury i to następna tura musi tę historię dowieźć. */
      needsReplay: boolean;
      broker?: Broker;
      current?: Turn;
      buffer: string;
      stderr: string;
      /** prompt systemowy, z którym ten proces wstał (--append-system-prompt) */
      system: string;
      /** do LRU: monotoniczny licznik użycia. NIE zegar — dwie tury w tej samej
       *  milisekundzie dałyby remis i eksmisję świeżo powołanego procesu. */
      lastUsed: number;
      idleTimer?: ReturnType<typeof setTimeout>;
      onLine?: (line: string) => void;
      /** multibot (B): pierwszy znak życia z procesu — rozbraja watchdoga tury */
      onData?: () => void;
      finish?: (ok: boolean, stopReason: string | null, cost?: number | null) => void;
    };
    // One active turn per thread; workers survive completed turns. The CLI
    // itself owns conversation state, so --resume is only needed after a
    // worker restart.
    const active = new Map<string, { stop: () => void; turnId: string; broker?: Broker }>();
    const workers = new Map<string, Worker>();
    let useSeq = 0;
    // multibot: ubijamy najdawniej używane BEZCZYNNE procesy, nigdy takiego z turą
    // w locie. Bez limitu każdy wątek trzymałby własny CLI przez godzinę.
    // `protect` to wątek, dla którego właśnie stawiamy proces — jego `current`
    // jeszcze nie istnieje, więc bez tego wyjątku mógłby paść własną ofiarą.
    const reapWarmWorkers = (protect: string) => {
      const limit = maxWarmWorkers();
      if (limit <= 0 || workers.size <= limit) return;
      const idle = [...workers.entries()]
        .filter(([key, w]) => !w.current && key !== protect)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [key, victim] of idle) {
        if (workers.size <= limit) break;
        workers.delete(key);
        if (victim.idleTimer) clearTimeout(victim.idleTimer);
        victim.broker?.close();
        killTree(victim.child);
      }
    };

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
      const turnId = newId();
      const selectedModel = cliModel(turn.model);
      const requestedReasoning = (turn as SendTurnInput & { reasoning?: string }).reasoning;
      const permissionMode = policy ? "default" : config.permissionMode === "auto" ? "acceptEdits" : config.permissionMode;
      const socketPath = permissionSocketPath(threadId);
      const args = [
        "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
        "--include-partial-messages", "--permission-mode", permissionMode,
        // multibot: bot MultiBota dostaje WYŁĄCZNIE serwery, które montujemy
        // niżej. Bez tego CLI dokłada globalną konfigurację MCP właściciela
        // maszyny — na telefonie bot widział prywatne konektory claude.ai
        // (Gmail, Supabase…), o które nikt go nie prosił i których nie
        // sprawdza żadna bramka uprawnień tego harnessu.
        "--strict-mcp-config",
      ];
      // Haiku has no adaptive-effort control in Claude Code.
      if (selectedModel !== "claude-haiku-4-5") args.push("--effort", requestedReasoning || "low");

      // integrations → MCP servers; this object is also the worker signature.
      const mcpServers: Record<string, unknown> = buildMcpServers(
        turn.integrations, undefined, canUseIntegration(threadId, "integrations"),
      );
      const allowed: string[] = Object.keys(mcpServers).map((name) => `mcp__${name}`);
      if (turn.integrations?.computer) {
        mcpServers.computer = { command: process.execPath, args: [PROXY_PATH], env: {
          ...NODE_ENV_FLAG, OGB_BOX_ID: turn.integrations.computer.boxId, OGB_BOX_TOKEN: turn.integrations.computer.token,
        } };
        allowed.push("mcp__computer");
      } else if (turn.integrations?.localComputer) {
        // multibot (A1): serwer komputera, ten sam stdio co u codexa. Claude
        // Code czeka na wolno wstające serwery i nie pomija ich po cichu —
        // wyścig z sekcji A1 (omitting pending optional MCP server) dotyczy
        // tylko codexa. Awarię serwera Claude raportuje w ToolSearch; tura nie
        // pada i bot wie, że komputera nie ma.
        mcpServers.computer = { ...turn.integrations.localComputer };
        allowed.push("mcp__computer");
      }
      if (turn.integrations?.agents) {
        mcpServers.agents = { ...turn.integrations.agents };
        allowed.push("mcp__agents");
      }
      if (turn.integrations?.web && canUseIntegration(threadId, "browser")) {
        mcpServers.web = { ...turn.integrations.web };
        allowed.push("mcp__web");
      }
      const brokerNeeded = Boolean(policy || config.permissionMode !== "bypassPermissions");
      if (brokerNeeded) {
        args.push("--permission-prompt-tool", "mcp__ogb__approve");
        mcpServers.ogb = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: { ...NODE_ENV_FLAG } };
        allowed.push("mcp__ogb");
      }
      const denied = [
        // multibot: własne narzędzie CLI do pytania człowieka działa tylko w
        // trybie interaktywnym. Tutaj model je wołał, nie dostawał nic i
        // oznajmiał „brak odpowiedzi" — pytanie nigdy nie docierało do czatu.
        // Odcinamy je, żeby model sięgnął po `mcp__agents__ask_user`, które
        // stawia w czacie prawdziwą kartę i czeka na człowieka.
        "AskUserQuestion",
        ...(policy ? [
          ...(policy.permissions.terminal === false ? ["Bash"] : []),
          ...(policy.permissions.file === false ? ["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"] : []),
          ...(policy.permissions.browser === false ? ["WebFetch", "WebSearch", "mcp__web"] : []),
        ] : []),
      ];
      args.push("--disallowedTools", denied.join(","));
      if (Object.keys(mcpServers).length) {
        args.push("--mcp-config", JSON.stringify({ mcpServers }), "--allowedTools", allowed.join(","));
      }
      // multibot: to jest podpis PROCESU, nie tury — wszystko tutaj jest zapiekane
      // w argv przy spawnie, więc zmiana wymaga nowego procesu. `system` celowo
      // tu NIE MA: prompt systemowy niesie pamięć bota (sharedFacts/sharedMemory/
      // sharedSkills z server/index.ts), więc każdy zapis do pamięci zmieniał
      // podpis i kosztował pełny zimny start. Zmieniony kontekst dowozimy niżej
      // wiadomością — model dostaje aktualną pamięć, ale bez restartu CLI.
      const signature = JSON.stringify({
        selectedModel, effort: selectedModel === "claude-haiku-4-5" ? null : requestedReasoning || "low",
        permissionMode, denied, cwd: turn.cwd ?? homedir(), mcpServers,
      });

      // multibot: rozgrzewka — proces ma wstać i czekać, bez tury. Podpis liczy
      // się tym samym kodem co prawdziwa tura, więc rozgrzany worker zostaje
      // ponownie użyty zamiast paść od razu na niezgodność podpisu.
      const warmOnly = (turn as SendTurnInput & { warmOnly?: boolean }).warmOnly === true;

      const spawnWorker = (resume: string | null): Worker => {
        // multibot (A1): Claude Code NIE ma wyścigu codexa — czeka na łączące się
        // serwery MCP (tool search / WaitForMcpServers), a awarię serwera zgłasza
        // Claude'owi zamiast cicho pominąć narzędzia. `MCP_TIMEOUT` to startup
        // timeout serwerów MCP (default 10 s; 30 s zostawia zapas na wolny dzień
        // s10e — mierzone jeszcze na pythonowym serwerze komputera, który wstawał
        // ~4 s; dzisiejszy node'owy wstaje od razu).
        // Stdio serwery nie reconnectują się same, więc start musi się zmieścić
        // w tym oknie — stąd podbicie, a nie domyślne 10 s.
        const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error", MCP_TIMEOUT: "30000" };
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        const sessionId = resume ?? newId();
        const launchArgs = [...args, resume ? "--resume" : "--session-id", sessionId, "--model", selectedModel];
        if (turn.system) launchArgs.push("--append-system-prompt", turn.system);
        const cli = cliSpawn(config.cli, launchArgs);
        const child = spawn(cli.command, cli.args, {
          cwd: turn.cwd ?? homedir(), env, stdio: ["pipe", "pipe", "pipe"],
          windowsVerbatimArguments: cli.windowsVerbatimArguments, detached: true,
        });
        const fresh: Worker = { child, signature, sessionId, needsReplay: resume === null, buffer: "", stderr: "", system: turn.system ?? "", lastUsed: ++useSeq };
        workers.set(threadId, fresh);
        return fresh;
      };

      let worker = workers.get(threadId);
      if (worker && worker.signature !== signature) {
        workers.delete(threadId);
        worker.broker?.close();
        killTree(worker.child);
        worker = undefined;
      }
      let spawnedWorker = false;
      if (!worker || worker.child.stdin?.destroyed) {
        worker = spawnWorker(typeof turn.resumeCursor === "string" ? turn.resumeCursor : null);
        spawnedWorker = true;
        reapWarmWorkers(threadId);
      }
      if (worker.idleTimer) clearTimeout(worker.idleTimer);
      worker.lastUsed = ++useSeq;
      // multibot: prompt systemowy trafia do CLI raz, przy spawnie. Gdy zmienił
      // się między turami (bot coś zapamiętał, doszedł skill, zmieniła się
      // autonomia), dowozimy go tą turą zamiast stawiać proces od nowa.
      const systemNow = turn.system ?? "";
      const contextUpdate = !spawnedWorker && worker.system !== systemNow ? systemNow : "";
      worker.system = systemNow;
      const current: Turn = { turnId, settled: false, sawStreamDelta: false };
      // Rozgrzewka NIE jest turą: bez `current` nie ma zdarzeń, nie ma wpisu w
      // `active` i kolejna prawdziwa tura nie odbija się o „a turn is already
      // running".
      if (!warmOnly) worker.current = current;
      let firstEventTimer: ReturnType<typeof setTimeout> | undefined;

      // multibot: zegar bezczynności zbrojony w jednym miejscu — po turze i po
      // rozgrzewce, żeby proces postawiony „na zapas" też kiedyś zszedł.
      const armIdle = () => {
        // W trybie bez limitu bezczynność nie ubija procesu: cały sens „każdy
        // bot zawsze active" polega na tym, że bot po tygodniu ciszy odpowiada
        // tak samo szybko jak w środku rozmowy. Pamięci pilnuje wtedy liczba
        // botów, a nie zegar.
        if (maxWarmWorkers() <= 0) return;
        const w = worker!;
        if (w.idleTimer) clearTimeout(w.idleTimer);
        w.idleTimer = setTimeout(() => {
          if (!w.current && workers.get(threadId) === w) {
            workers.delete(threadId);
            w.broker?.close();
            killTree(w.child);
          }
        }, WORKER_IDLE_MS);
        w.idleTimer.unref?.();
      };

      const settle = (ok: boolean, stopReason: string | null, cost: number | null = null) => {
        if (current.settled) return;
        current.settled = true;
        if (firstEventTimer) clearTimeout(firstEventTimer);
        if (worker?.current === current) worker.current = undefined;
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost });
        if (worker && workers.get(threadId) === worker) armIdle();
      };
      const broker = worker.broker ?? (brokerNeeded ? createPermissionBroker({
        socketPath,
        onAsk: (ask) => {
          const remembered = approvalRule(DRIVER_KIND, ask.tool, ask.input, ask.suggestions);
          if (ask.kind === "permission" && !toolAllowed(threadId, ask.tool)) {
            queueMicrotask(() => worker?.broker?.answer(ask.id, "deny", `${ask.tool} blocked by bot permissions`));
            return;
          }
          if (ask.kind === "permission" && autoApproveAllowed(threadId, ask.tool)) {
            queueMicrotask(() => worker?.broker?.answer(ask.id, "allow"));
            return;
          }
          if (ask.kind === "permission" && approvalRuleAllowed(threadId, remembered)) {
            queueMicrotask(() => worker?.broker?.answer(ask.id, "always"));
            return;
          }
          const activeTurn = worker?.current;
          if (!activeTurn) return;
          emit({ ...base(threadId, activeTurn.turnId), type: "request.opened", requestId: ask.id,
            requestType: ask.kind, tool: ask.tool, summary: askSummary(ask),
            choices: Array.isArray(ask.input?.choices) ? (ask.input.choices as string[]).slice(0, 5) : undefined,
            ...(ask.input?.multiple === true ? { multiple: true } : {}),
            ...(typeof ask.input?.detail === "string" && ask.input.detail.trim() ? { detail: ask.input.detail.trim().slice(0, 400) } : {}),
            ...(ask.kind === "permission" ? { approvalRule: remembered } : {}) });
        },
        onResolve: (resolved) => {
          const activeTurn = worker?.current;
          if (activeTurn) emit({ ...base(threadId, activeTurn.turnId), type: "request.resolved",
            requestId: resolved.id, behavior: resolved.behavior, source: resolved.source });
        },
      }) : undefined);
      if (broker) worker.broker = broker;
      current.broker = broker;

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
        if (!worker?.current) return;
        switch (o.type) {
          case "system":
            if (o.subtype === "init") {
              worker!.sessionId = o.session_id ?? worker!.sessionId;
              const activeTurn = worker!.current;
              if (activeTurn) emit({ ...base(threadId, activeTurn.turnId), type: "session.started", sessionId: o.session_id, model: o.model });
            } else if (o.subtype === "thinking_tokens") {
              if (worker!.current) emit({ ...base(threadId, worker!.current.turnId), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
            }
            break;
          case "stream_event": {
            // subagent narration is dropped — N parallel Tasks would
            // interleave their prose into one bubble (upstream-verified bug)
            if (o.parent_tool_use_id) break;
            const ev = o.event ?? {};
            if (ev.type !== "content_block_delta") break;
            const d = ev.delta ?? {};
            if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
              worker!.current!.sawStreamDelta = true;
              emit({ ...base(threadId, worker!.current!.turnId), type: "content.delta", streamKind: "assistant_text", delta: d.text });
            } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              emit({ ...base(threadId, worker!.current!.turnId), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
            }
            break;
          }
          case "assistant": {
            const msg = o.message ?? {};
            // A stale CLI reports "…or newer is required" as ordinary assistant
            // text; staleCliNotice starts `claude update` and says so.
            const text = staleCliNotice(firstText(msg.content));
            if (text.trim()) {
              // fallback delta for CLIs/paths that never streamed the block
              if (!worker!.current!.sawStreamDelta) {
                emit({ ...base(threadId, worker!.current!.turnId), type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              worker!.current!.sawStreamDelta = false;
              emit({ ...base(threadId, worker!.current!.turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                emit({ ...base(threadId, worker!.current!.turnId), type: "item.started", itemType: "tool", itemId: b.id, title: b.name });
              }
            }
            if (msg.usage) {
              emit({
                ...base(threadId, worker!.current!.turnId),
                type: "thread.token-usage.updated",
                input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
                output: msg.usage.output_tokens || 0,
              });
            }
            break;
          }
          case "user":
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                emit({ ...base(threadId, worker!.current!.turnId), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error });
              }
            }
            break;
          case "result":
            settle(o.is_error !== true, o.stop_reason ?? o.terminal_reason ?? null, o.total_cost_usd ?? null);
            break;
        }
      };
      worker.onLine = handleLine;
      worker.finish = settle;

      // multibot: uchwyty pinujemy do KONKRETNEGO procesu (`w`), nie do zmiennej
      // `worker`. Po podmianie workera (inny podpis, respawn po zawisie) stare
      // `close` starego procesu strzelało w NOWY: zdejmowało go z mapy i
      // wywracało jego turę komunikatem „claude exited … before result".
      const attach = (w: Worker) => {
        w.child.stdout!.on("data", (chunk) => {
          w.onData?.();
          w.buffer += chunk;
          let nl;
          while ((nl = w.buffer.indexOf("\n")) !== -1) {
            const line = w.buffer.slice(0, nl);
            w.buffer = w.buffer.slice(nl + 1);
            if (line.trim()) w.onLine?.(line);
          }
        });
        w.child.stderr!.on("data", (c) => {
          w.stderr += c;
          if (w.stderr.length > 8192) w.stderr = w.stderr.slice(-8192);
        });
        w.child.once("error", (e) => {
          const activeTurn = w.current;
          const errorTurnId = activeTurn?.turnId ?? turnId;
          emit({ ...base(threadId, errorTurnId), type: "runtime.error", message: `spawn failed: ${e.message}` });
          w.finish?.(false, "spawn_error");
        });
        w.child.once("close", (code) => {
          const activeTurn = w.current;
          if (activeTurn && !activeTurn.settled) {
            emit({
              ...base(threadId, activeTurn.turnId),
              type: "runtime.error", message: `claude exited ${code} before result${w.stderr ? `: ${w.stderr.trim().slice(-300)}` : ""}`,
            });
            w.finish?.(false, "exit_before_result");
          }
          w.broker?.close();
          if (workers.get(threadId) === w) workers.delete(threadId);
        });
      };
      if (spawnedWorker) attach(worker);

      // Rozgrzewka kończy się TU: proces stoi, broker stoi, nic nie poszło na
      // stdin. Pierwsza prawdziwa tura zastanie ciepły CLI.
      if (warmOnly) {
        armIdle();
        return { turnId };
      }

      const stop = () => {
        settle(true, "cancelled");
        killTree(worker!.child);
      };
      active.set(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // Keep stdin open: Claude Code accepts multiple stream-json user frames.
      const nativeImages = (turn.attachments ?? []).filter((file) => /^image\/(?:png|jpeg|gif|webp)$/i.test(file.mime));
      const turnText = contextUpdate
        ? `[MultiBot] Updated workspace context — this replaces the context you were given at session start; where they differ, this one wins:\n${contextUpdate}\n\n${turn.text}`
        : turn.text;
      // Sesja bez `--resume` nie zna rozmowy — dokładamy ją RAZ, z dysku.
      const replay = worker!.needsReplay ? historyBlock(turn.transcript) : "";
      worker!.needsReplay = false;
      const promptText = replay ? `${replay}\n\n${turnText}` : turnText;
      const content = nativeImages.length
        ? [
            { type: "text", text: promptText },
            ...nativeImages.map((file) => ({
              type: "image",
              source: { type: "base64", media_type: file.mime, data: readFileSync(file.path).toString("base64") },
            })),
          ]
        : promptText;
      const promptMsg = { type: "user", message: { role: "user", content } };

      // multibot (B): żywotność workera mierzyliśmy przez `child.stdin.destroyed`,
      // a `child` to proces PROOTA — proot potrafi żyć z martwym claude w środku
      // (zaobserwowane), więc tura szła do rury, której nikt nie czyta, i wisiała
      // bez końca. Pilnujemy więc PIERWSZEGO znaku życia na stdout: nie ma go w
      // budżecie → proces jest martwy, ubijamy, stawiamy nowy i powtarzamy turę
      // RAZ; dopiero drugie milczenie idzie do użytkownika jako błąd. Budżet
      // dotyczy wyłącznie pierwszego bajtu — długie tury zostają nietknięte.
      // stderr się NIE liczy: proot wypisuje tam ostrzeżenia także wtedy, gdy CLI
      // w środku już nie żyje.
      let freshSpawn = spawnedWorker;
      let retried = false;
      const sendPrompt = () => {
        const w = worker!;
        w.onData = () => {
          if (firstEventTimer) clearTimeout(firstEventTimer);
          firstEventTimer = undefined;
        };
        try {
          w.child.stdin!.write(JSON.stringify(promptMsg) + "\n");
        } catch (error) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: `claude input failed: ${error instanceof Error ? error.message : String(error)}` });
          settle(false, "stdin_error");
          killTree(w.child);
          return;
        }
        firstEventTimer = setTimeout(onSilence, firstEventMs(freshSpawn));
        firstEventTimer.unref?.();
      };
      function onSilence() {
        firstEventTimer = undefined;
        if (current.settled) return;
        const dead = worker!;
        // Sprzątamy MARTWEGO tak, żeby jego `close` nie ruszył tury ani nowego
        // procesu: bez `current` nie zgłosi błędu, bez brokera go nie zamknie
        // (broker jest na wątek i przechodzi do następcy).
        dead.current = undefined;
        dead.onData = undefined;
        dead.onLine = undefined;
        dead.finish = undefined;
        const inherited = dead.broker;
        dead.broker = undefined;
        if (dead.idleTimer) clearTimeout(dead.idleTimer);
        if (workers.get(threadId) === dead) workers.delete(threadId);
        killTree(dead.child);
        if (retried) {
          inherited?.close();
          emit({ ...base(threadId, turnId), type: "runtime.error", message: "claude worker gave no sign of life, also after a restart" });
          settle(false, "worker_unresponsive");
          return;
        }
        retried = true;
        // Sesja mogła już istnieć (worker odpowiadał wcześniej) — wznawiamy ją,
        // żeby powtórzona tura nie zgubiła kontekstu rozmowy.
        worker = spawnWorker(dead.sessionId);
        worker.broker = inherited;
        worker.current = current;
        worker.onLine = handleLine;
        worker.finish = settle;
        attach(worker);
        freshSpawn = true;
        sendPrompt();
      }
      sendPrompt();
      appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: promptMsg });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        const cli = cliSpawn(config.cli, ["--version"]); // multibot
        execFile(
          cli.command,
          cli.args,
          {
            timeout: 8000,
            env: { ...process.env, PATH: augmentedPath() },
            windowsVerbatimArguments: cli.windowsVerbatimArguments,
          },
          (err, stdout) => resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const termuxRoot = process.env.PREFIX
        ? join(process.env.PREFIX, "var", "lib", "proot-distro", "installed-rootfs", "debian", "root")
        : null;
      const authenticated = [
        join(homedir(), ".claude", ".credentials.json"),
        ...(termuxRoot ? [join(termuxRoot, ".claude", ".credentials.json")] : []),
      ].some(existsSync);
      return { state: "available", version, authenticated };
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
        capabilities: { sessionModelSwitch: "in-session", agentsMcp: true, webTools: "mcp" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const broker = active.get(threadId)?.broker;
          if (!broker) throw new Error("no active turn with a permission broker on this thread");
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message)) {
            throw new Error("no such pending request (it may have timed out)");
          }
        },
        hasSession: (threadId) => workers.has(threadId),
        stopAll: async () => {
          for (const worker of workers.values()) {
            worker.broker?.close();
            killTree(worker.child);
          }
          workers.clear();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt: string) =>
        new Promise((resolve, reject) => {
          // multibot
          const cli = cliSpawn(config.cli, ["-p", prompt, "--model", "haiku", "--output-format", "text"]);
          execFile(
            cli.command,
            cli.args,
            {
              timeout: 60_000,
              env: { ...process.env, PATH: augmentedPath() },
              windowsVerbatimArguments: cli.windowsVerbatimArguments,
            },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
          );
        }),
      dispose: async () => {
        for (const worker of workers.values()) {
          worker.broker?.close();
          killTree(worker.child);
        }
        workers.clear();
        listeners.clear();
      },
    };
  },
};
