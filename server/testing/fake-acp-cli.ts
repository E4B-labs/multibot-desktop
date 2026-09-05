#!/usr/bin/env node
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_MODE   happy (default) | exit-early | crash-mid-turn | hang | no-auth | permission
//                   | notify-user/request-connection (call the matching agents tool once
//                     and finish the turn — neither of them waits for the human)
//                   | ask-peer/send-mail (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | relay (forward to the next bot named for THIS bot in
//                     FAKE_ACP_RELAY_MAP, then end with [TASK COMPLETE] once
//                     its hops run out — the peer-conversation ring e2e)
//                   | script (reply chosen by what the prompt CONTAINS —
//                     FAKE_ACP_SCRIPT = {default, rules:[{match,text}], tool};
//                     the group-chat e2e. `tool: true` calls list_bots on the
//                     injected agents server first, so the turn counts as one
//                     that used a tool — a real fleet almost never has a turn
//                     that did not.)
//   FAKE_ACP_RELAY_MAP  path to a JSON file {botId: [nextBotId, ...]} plus the
//                   per-bot turn counters the relay mode keeps beside it
//   FAKE_ACP_DUMP   path to write {argv, env, mcpServers} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_PROMPT_DUMP  path to append every received session/prompt as a
//                   JSON line ({mode, at, prompt}) — lets tests pin what text
//                   actually reached the CLI and when
//   FAKE_ACP_TURN_MS  how long the `busy` mode's turn runs (default 5000)
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("fake-acp 1.0.0");
  process.exit(0);
}
if (process.env.FAKE_ACP_DUMP) {
  writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify({ argv, env: process.env }, null, 2));
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
let onPermissionAnswered: (() => void) | null = null;

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => unknown }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
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
        if (msg.id === undefined) continue;
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
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
    handle(msg);
  }
});

function handle(msg: any) {
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    onPermissionAnswered?.();
    return;
  }
  if (!msg.method) return;

  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      const authMethods = mode === "no-auth" ? [] : [{ id: "cached_token" }];
      result(msg.id, { protocolVersion: 1, authMethods, _meta: { modelState: { currentModelId: "fake-acp-model" } } });
      break;
    }
    case "authenticate":
      result(msg.id, {});
      break;
    case "session/new": {
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      // Real agents validate this payload (OpenCode rejects a non-spec HTTP
      // entry and the whole turn dies), so tests get to assert the shape.
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify({ argv, env: process.env, mcpServers: servers }, null, 2));
      }
      result(msg.id, { sessionId: "fake-acp-session" });
      break;
    }
    case "session/load": {
      // A resumed session carries the same mcpServers as a new one; without
      // capturing them here a restarted process loses its peer tools halfway
      // through a conversation.
      const loaded: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      agentsMcp = loaded.find((s: any) => s?.name === "agents") ?? agentsMcp;
      result(msg.id, {});
      break;
    }
    case "session/prompt": {
      // multibot: dowód dla testów, CO fake dostało w prompcie — drivery CLI
      // nie czytają pola `transcript`, więc prompt to jedyny kanał treści.
      if (process.env.FAKE_ACP_PROMPT_DUMP) {
        appendFileSync(
          process.env.FAKE_ACP_PROMPT_DUMP,
          `${JSON.stringify({ mode, at: Date.now(), prompt: msg.params?.prompt ?? null })}\n`,
        );
      }
      const complete = () =>
        result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
      // Synteza teach-a-task jest zwykłą turą tekstową, więc rozpoznajemy ją po
      // prompcie (`teachSynthesisPrompt` w server/index.ts), nie po trybie — ma
      // działać dla każdej atrapy, bo w produkcji działa dla każdego drivera.
      // Odpowiedź celowo ma prozę PRZED blokiem i własny płotek ``` w środku
      // `instructions`: dokładnie to, na czym łamie się naiwne wycinanie bloku.
      if (JSON.stringify(msg.params?.prompt ?? "").includes("demonstrated a task in your browser")) {
        const skill = JSON.stringify({
          name: "shop-order",
          description: "Place an order in the shop.",
          instructions: "1. Open the orders page.\n\n```\nnotes\n```\n\n## Before the first run\n\n## After each run\n",
        });
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "Sure — here it is:\n\n```json\n" + skill + "\n```" },
            },
          },
        });
        return complete();
      }
      if (mode === "hang") {
        // never resolve the prompt — lets tests exercise interrupt
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "error-mid-turn") {
        // Dostawca odpowiada BŁĘDEM na prompt, ale proces żyje dalej — sesja
        // zostaje otwarta. To ta ścieżka, którą harness zamienia na
        // runtime.error bez turn.completed.
        setTimeout(() => {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "provider exploded" } });
        }, 400);
        return;
      }
      if (mode === "crash-mid-turn") {
        // Prawdziwe CLI potrafi paść PO otwarciu sesji, w środku tury: brak
        // klucza, ubity proces, wyjątek dostawcy. Harness zamienia to na
        // zdarzenie runtime.error — i to jest jedyny sygnał, że tura się
        // skończyła, bo turn.completed już nie przyjdzie.
        process.stderr.write("fake-acp: simulated provider failure mid-turn\n");
        process.exit(4);
      }
      if (mode === "script") {
        // multibot: tryb dla czatu grupowego — odpowiedź wybierana po TRESCI
        // promptu, nie po liczniku tur. Grupa dostarcza wiadomosci po kolei i
        // jeden bot moze dostac dwie tury w jednej wymianie, wiec licznik
        // (jak w trybie `room`) byl nieprzewidywalny; dopasowanie do tekstu
        // jest deterministyczne. FAKE_ACP_SCRIPT = JSON
        // {default, rules: [{match, text}]} — wygrywa pierwsza pasujaca regula.
        const chunk = (text: string) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
        let script: { default?: string; rules?: Array<{ match: string; text: string }>; tool?: boolean } = {};
        try {
          script = JSON.parse(process.env.FAKE_ACP_SCRIPT ?? "{}");
        } catch {
          script = {};
        }
        const prompt = JSON.stringify(msg.params?.prompt ?? "");
        const hit = (script.rules ?? []).find((rule) => prompt.includes(rule.match));
        const say = hit?.text ?? script.default ?? "nothing to add";
        if (script.tool && agentsMcp) {
          void driveMcp(agentsMcp, [{ name: "list_bots", args: () => ({}) }])
            .catch(() => "")
            .then(() => {
              chunk(say);
              complete();
            });
          return;
        }
        chunk(say);
        complete();
        return;
      }
      if (mode === "busy") {
        const chunk = (text: string) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
        chunk("main turn still running");
        // FAKE_ACP_TURN_MS: ile tura ma trwać. Testy równoległości potrzebują
        // tury krótszej niż domyślne pięć sekund, ale wciąż mierzalnej.
        setTimeout(complete, Number(process.env.FAKE_ACP_TURN_MS) || 5_000);
        return;
      }
      if (mode === "room") {
        // collaboration-room turn: one contribution per process, so progress
        // lives in a counter file (FAKE_ACP_ROOM_COUNTER) — the first turn
        // contributes plain work, the second ends with the done marker, so a
        // room gets a full exchange both ways before it settles.
        const counterFile = process.env.FAKE_ACP_ROOM_COUNTER;
        let n = 0;
        if (counterFile) {
          try {
            n = Number.parseInt(readFileSync(counterFile, "utf8"), 10) || 0;
          } catch {
            n = 0;
          }
          writeFileSync(counterFile, String(n + 1));
        }
        const done = n >= 1;
        // multibot: dowód dla testu, że wkładka kolegi dojechała W PROMPCIE —
        // drivery CLI nie czytają pola transcript, więc to jedyna droga.
        const sawPeer = JSON.stringify(msg.params?.prompt ?? "").includes("room work from fake");
        const chunk = (text: string) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
        if (done) {
          chunk(`${sawPeer ? "peer seen — " : ""}room work from fake\n[TASK COMPLETE]`);
          complete();
        } else {
          // multibot: pierwsza tura strumieniuje DWOMA kawałkami rozciętymi w
          // połowie wyrazu i domyka się z opóźnieniem — test sprawdza, że
          // wkładka jest w pokoju ZANIM tura się skończy ORAZ że kawałki
          // skleiły się w jedną wiadomość ("room work from fake").
          chunk("room work fr");
          setTimeout(() => chunk("om fake"), 1_300);
          setTimeout(complete, 3_200);
        }
        return;
      }
      if (mode === "goal") {
        // /goal loop: one process per turn, so progress lives in a counter
        // file (FAKE_ACP_GOAL_COUNTER) — the first turn reports progress, the
        // second finishes with [GOAL COMPLETE] so runGoal settles to "done".
        const counterFile = process.env.FAKE_ACP_GOAL_COUNTER;
        let n = 0;
        if (counterFile) {
          try {
            n = Number.parseInt(readFileSync(counterFile, "utf8"), 10) || 0;
          } catch {
            n = 0;
          }
          writeFileSync(counterFile, String(n + 1));
        }
        const done = n >= 1;
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { text: done ? "goal work from fake step 2\n[GOAL COMPLETE]" : "goal work from fake step 1" } } },
        });
        complete();
        return;
      }
      // relay: the peer-conversation e2e. Each turn looks up its OWN bot id in
      // the agents MCP env, reads the hop list for it from FAKE_ACP_RELAY_MAP
      // (a JSON file the test writes once the bots exist) and forwards to the
      // next bot. When its hops run out it ends the conversation with the done
      // marker, so a ring A→B→C→A terminates on its own.
      if (mode === "relay") {
        const chunk = (text: string) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
        const self = (agentsMcp?.env ?? []).find((e) => e.name === "OMB_BOT_ID")?.value ?? "";
        const mapFile = process.env.FAKE_ACP_RELAY_MAP ?? "";
        let hops: string[] = [];
        let turn = 0;
        try {
          hops = (JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, string[]>)[self] ?? [];
        } catch {
          hops = [];
        }
        const counterFile = `${mapFile}.${self}.count`;
        try {
          turn = Number.parseInt(readFileSync(counterFile, "utf8"), 10) || 0;
        } catch {
          turn = 0;
        }
        try {
          writeFileSync(counterFile, String(turn + 1));
        } catch {
          /* counter is best effort */
        }
        const next = hops[turn];
        if (!next || !agentsMcp) {
          chunk(`relay ${self} has nothing left to forward\n[TASK COMPLETE]`);
          complete();
          return;
        }
        void driveMcp(agentsMcp!, [
          { name: "send_bot_mail", args: () => ({ bot_id: next, message: `relay hop ${turn} from ${self}` }) },
        ])
          .then((ack) => {
            chunk(`forwarded to ${next}: ${ack}`);
            complete();
          })
          .catch((e) => {
            chunk(`relay error: ${(e as Error).message}`);
            complete();
          });
        return;
      }
      if (mode === "send-mail" && agentsMcp) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "send_bot_mail",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "async ping" }),
          },
        ])
          .then((ack) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `sent: ${ack}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `mail error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "ask-peer" && agentsMcp) {
        // the comms e2e: reach a peer bot through the injected agents proxy
        // and reply with whatever it said (the peer's fake runs plain happy
        // — its depth-1 turn gets no agents server, so no recursion)
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      // ask-user: bot pyta właściciela przez ten sam serwer `agents` i czeka na
      // odpowiedź człowieka — droga, której drivery ACP wcześniej nie miały
      if (mode === "ask-user" && agentsMcp) {
        void driveMcp(agentsMcp, [
          { name: "ask_user", args: () => ({ question: "Which database?", choices: ["Postgres", "SQLite"] }) },
        ])
          .then((answer) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `owner says: ${answer}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `ask error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      // notify-user / request-connection: narzędzia, które NIE czekają na
      // człowieka — bot woła jedno z nich i od razu kończy turę
      if ((mode === "notify-user" || mode === "request-connection") && agentsMcp) {
        const call =
          mode === "notify-user"
            ? { name: "notify_user", args: () => ({ title: "Raport gotowy", body: "Zebrałem dane z wczoraj." }) }
            : {
              name: "request_connection",
              // FAKE_ACP_CONNECTOR: the model names the APP it needs
              // ("discord"), not one of the four fixed panel targets.
              args: () => ({ connector: process.env.FAKE_ACP_CONNECTOR ?? "google-workspace", why: "Muszę wysłać maila." }),
            };
        void driveMcp(agentsMcp, [call])
          .then((answer) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `${mode}: ${answer}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `${mode} error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      // handoff: bot oddaje komputer człowiekowi i czeka na jego odpowiedź
      if (mode === "handoff" && agentsMcp) {
        void driveMcp(agentsMcp, [
          { name: "hand_over_computer", args: () => ({ reason: "Sign in to LinkedIn, then hand it back" }) },
        ])
          .then((answer) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `handoff: ${answer}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `handoff error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      playTurn();
      if (mode === "permission") {
        // ask the client to approve a tool, then complete once answered
        pendingPermissionId = 9001;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      complete();
      break;
    }
    case "session/cancel":
      // the interrupted prompt resolves as cancelled
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
