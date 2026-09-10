// permission-proxy — the MCP stdio server the claude CLI spawns for
// --permission-prompt-tool (ported from agentcal's runPermissionProxy;
// dedicated entry file, so there is no argv-dispatch fork-bomb hazard).
// Forwards each ask over a unix socket to the broker living in the
// MultiBot server and waits for the human's answer.
//
//   approve   — the CLI calls this for any tool use its permission mode
//               would deny; the answer is the --permission-prompt-tool
//               JSON contract ({behavior:"allow"|"deny", …}).
//   ask_user  — the agent can pose a question mid-run and wait; the
//               human's words come back verbatim.
//
// stdout is the MCP channel — never console.log here.
import { connect } from "node:net";
import { randomUUID } from "node:crypto";

const socketPath = process.argv[2] ?? "";

const BROKER_DOWN = "MultiBot: permission broker unavailable — skip this action";

const waiting = new Map<string, (msg: any) => void>();
const dead = () => {
  for (const resolve of waiting.values()) resolve({ behavior: "deny", message: BROKER_DOWN });
  waiting.clear();
};

// multibot: połączenie zestawiane leniwie i odtwarzane po zerwaniu.
//
// Wcześniej gniazdo było jedno, otwierane raz przy starcie procesu, a `close`
// i `error` tylko odrzucały wiszące pytania. Broker żyje jednak przez JEDNĄ
// turę (harness woła `broker.close()` na jej końcu), a proces CLI wraz z tym
// proxy jest współdzielony między turami. Po pierwszej turze połączenie było
// więc martwe na zawsze i KAŻDA kolejna zgoda kończyła się odmową — bot tracił
// `Bash`, `Write`, `write_file` i całą resztę do końca życia procesu, mówiąc
// tylko „broker uprawnień nie odpowiada". Ścieżka gniazda jest stała dla wątku,
// więc wystarczy połączyć się ponownie.
let conn: ReturnType<typeof connect> | null = null;
let connBuf = "";

function link(): Promise<ReturnType<typeof connect> | null> {
  if (conn && !conn.destroyed) return Promise.resolve(conn);
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const fail = () => {
      socket.destroy();
      conn = null;
      resolve(null);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.removeListener("error", fail);
      socket.on("error", () => ((conn = null), dead()));
      socket.on("close", () => ((conn = null), dead()));
      socket.on("data", (chunk) => {
        connBuf += chunk;
        let nl;
        while ((nl = connBuf.indexOf("\n")) !== -1) {
          const line = connBuf.slice(0, nl);
          connBuf = connBuf.slice(nl + 1);
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.t === "answer") {
            waiting.get(msg.id)?.(msg);
            waiting.delete(msg.id);
          }
        }
      });
      connBuf = "";
      conn = socket;
      resolve(socket);
    });
  });
}

const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

const TOOLS = [
  {
    name: "approve",
    description: "Ask the MultiBot user whether a tool use is allowed",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
        permission_suggestions: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["tool_name", "input"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the human who owns this bot a question and wait for their answer. Use whenever you need a decision, a preference, missing information, or sign-off before doing something consequential — do not guess on things the owner would want to decide. Returns their answer as text.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question itself, short — it is the title of the card the human sees" },
        choices: {
          type: "array",
          items: { type: "string" },
          description: "Optional 2-5 suggested answers, shown as one-tap buttons",
        },
        multiple: {
          type: "boolean",
          description: "Set `multiple: true` whenever more than one of the choices can be right at the same time (days, features, files); leave it out only when the answers are mutually exclusive. Choice labels must not contain a comma, because the answer comes back as the chosen labels joined by commas.",
        },
        detail: {
          type: "string",
          description: "Optional background for the question, shown small under it. Keep it out of `question`.",
        },
      },
      required: ["question"],
    },
  },
];

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "multibot-permissions", version: "1" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const askId = randomUUID();
    const isQuestion = name === "ask_user";
    // the CLI may include its own suggested permission rules; on allow we
    // hand them straight back as updatedPermissions so claude stops asking
    // at its own layer — no invented rule syntax (agentcal)
    const suggestions = Array.isArray(args.permission_suggestions)
      ? args.permission_suggestions
      : Array.isArray(args.suggestions)
        ? args.suggestions
        : null;
    const socket = await link();
    const answer: any = await new Promise((resolve) => {
      if (!socket) return resolve({ behavior: "deny", message: BROKER_DOWN });
      waiting.set(askId, resolve);
      const ask = isQuestion
        ? { t: "ask", id: askId, kind: "question", tool: "ask_user", input: { question: args.question, choices: args.choices, multiple: args.multiple === true, detail: args.detail } }
        : { t: "ask", id: askId, tool: args.tool_name, input: args.input, suggestions };
      try {
        socket.write(JSON.stringify(ask) + "\n");
      } catch {
        waiting.delete(askId);
        resolve({ behavior: "deny", message: BROKER_DOWN });
      }
    });
    const text = isQuestion
      ? answer.message || "No answer was given — use your best judgment."
      : JSON.stringify(
          answer.behavior === "allow" || answer.behavior === "always"
            ? {
                behavior: "allow",
                updatedInput: args.input ?? {},
                ...(answer.behavior === "always" && suggestions ? { updatedPermissions: suggestions } : {}),
              }
            : { behavior: "deny", message: answer.message || "Denied from MultiBot" },
        );
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

let inBuf = "";
process.stdin.on("data", (chunk) => {
  inBuf += chunk;
  let nl;
  while ((nl = inBuf.indexOf("\n")) !== -1) {
    const line = inBuf.slice(0, nl);
    inBuf = inBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => process.exit(0));
