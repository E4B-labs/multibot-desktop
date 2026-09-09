// Contract test for the agent-to-agent comms MCP proxy (agents-proxy.ts):
// spawn it exactly the way a driver's mcpServers entry does (process.execPath
// + entry file + env) against a scripted stub of the harness's /api/internal
// endpoints, and drive the MCP stdio surface end to end. No shebang, no
// shell — plain node child, so this runs on every OS like index.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const TOKEN = "test-comms-token";

// scripted harness stub
let stub: Server;
let stubPort = 0;
let lastAuth: string | undefined;
let lastAskBody: any = null;
let lastActionBody: any = null;
let lastAttachmentBody: any = null;
let askResponse: unknown = { botName: "Helper", text: "hi from helper" };

// multibot: rutyny w atrapie trzymają stan, bo tylko wtedy test udowadnia to,
// na co skarżył się właściciel: bot zakładał rutynę i nie umiał jej ani
// wyłączyć, ani skasować, więc dwie wersje chodziły naraz. Kształt odpowiedzi
// mirroruje `routines.*` z server/index.ts.
let routines: Array<{ id: string; name: string; prompt: string; schedule: string | null; enabled: boolean }> = [];
let nextRoutineId = 1;
function routineAction(body: any): unknown {
  switch (body.action) {
    case "routines.list":
      return routines;
    case "routines.create": {
      const routine = {
        id: `r${nextRoutineId++}`,
        name: String(body.name),
        prompt: String(body.prompt),
        schedule: body.schedule ?? null,
        enabled: true,
      };
      routines.push(routine);
      return routine;
    }
    case "routines.update": {
      const routine = routines.find((r) => r.id === body.id);
      if (!routine) return { error: "no such routine" };
      for (const key of ["name", "prompt", "schedule", "enabled"] as const) {
        if (body[key] !== undefined) (routine as Record<string, unknown>)[key] = body[key];
      }
      return routine;
    }
    case "routines.delete": {
      const before = routines.length;
      routines = routines.filter((r) => r.id !== body.id);
      return { ok: routines.length !== before };
    }
    default:
      return null;
  }
}

let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/agents")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          bots: [
            {
              id: "bot-helper",
              name: "Helper",
              model: "fake-model",
              busy: false,
              // multibot (F9): persona bota z BotRecord — po niej wołający wybiera adresata
              description: "Research assistant — digs through papers and summarises them",
            },
            // bez opisu: linijka ma zostać poprawna, nie dokleić pustego myślnika
            { id: "bot-plain", name: "Plain", model: "fake-model", busy: true, description: "" },
          ],
        }),
      );
    }
    if (req.method === "POST" && req.url === "/api/internal/ask-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAskBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(askResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/agent-action") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data);
        lastActionBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body.action === "device.info" ? {
          platform: "linux",
          android: true,
          termux: true,
          manufacturer: "samsung",
          model: "SM-G970F",
        } : routineAction(body) ?? { ok: true }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/attachments") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAttachmentBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "att-1", name: lastAttachmentBody.name, mime: lastAttachmentBody.mime, size: 42 }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    env: {
      MULTIBOT_COMPUTER: "off",
      ...process.env,
      MULTIBOT_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      MULTIBOT_BOT_ID: "bot-asker",
      MULTIBOT_COMMS_TOKEN: TOKEN,
      MULTIBOT_TURN_DEPTH: "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  child.stdout!.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("agents-proxy MCP surface", () => {
  it("answers the MCP handshake and lists management tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("agents");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["list_bots", "ask_bot", "send_bot_mail", "read_bot_mail", "remember", "create_skill", "create_routine", "list_routines", "update_routine", "delete_routine", "create_agent", "get_agent", "update_agent", "delete_agent", "list_groups", "delete_group", "read_file", "run_command"]));
    const update = list.result.tools.find((tool: { name: string }) => tool.name === "update_agent");
    expect(update.inputSchema.properties.patch.properties).toMatchObject({
      description: { type: "string" },
      color: { enum: expect.arrayContaining(["purple"]) },
      mascotShape: { enum: expect.arrayContaining(["star"]) },
      avatarUrl: expect.any(Object),
      modelSelection: expect.any(Object),
    });
  });

  // multibot: rutyny CUDZEGO bota. `bot_id` musi siedzieć W `properties` -
  // obok nich schemat waliduje się tak samo, a model po prostu nigdy go nie
  // wyśle, więc "bot manages bots" cicho kończy się na własnych rutynach.
  it("offers an optional bot_id on every routine tool, inside the schema", async () => {
    const list = await rpc("tools/list");
    for (const name of ["create_routine", "list_routines", "update_routine", "delete_routine", "run_routine"]) {
      const tool = list.result.tools.find((t: { name: string }) => t.name === name);
      expect(tool.inputSchema.properties.bot_id, name).toMatchObject({ type: "string" });
      expect(tool.inputSchema.bot_id, name).toBeUndefined();
      expect(tool.inputSchema.required ?? []).not.toContain("bot_id");
    }
  });

  it("list_bots renders the roster and authenticates with the shared token", async () => {
    const res = await callTool("list_bots", {});
    const text = res.result.content[0].text;
    expect(text).toContain("Helper");
    expect(text).toContain("bot-helper");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("exposes verified host device facts", async () => {
    const res = await callTool("get_device_info", {});
    const text = res.result.content[0].text;
    expect(text).toContain("SM-G970F");
    expect(text).toContain("\"termux\": true");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("routes routine creation through the local MultiBot action API", async () => {
    const res = await callTool("create_routine", {
      name: "Hej Kacper",
      prompt: "hej kacper!",
      schedule: "35 1 * * *",
    });
    expect(res.result.content[0].text).toContain('"name": "Hej Kacper"');
    expect(lastActionBody).toMatchObject({
      fromBotId: "bot-asker",
      action: "routines.create",
      name: "Hej Kacper",
      prompt: "hej kacper!",
      schedule: "35 1 * * *",
    });
  });

  // multibot (F9): delegacja po opisie — bez tego pola adresata da się wybrać
  // tylko po nazwie, a nazwa nie mówi, czym bot się zajmuje.
  it("renders each peer's description so the caller can delegate by capability", async () => {
    const text = (await callTool("list_bots", {})).result.content[0].text;
    expect(text).toContain("Research assistant — digs through papers");
    // bot bez opisu zostaje bez doklejonego myślnika
    expect(text).toContain("- Plain (id: bot-plain, model: fake-model, busy)");
  });

  // ask_bot no longer waits for anything: the message becomes a real turn in
  // the other bot and its answer comes back as a separate turn of the caller's.
  it("ask_bot forwards the sender and answers with the delivery receipt", async () => {
    askResponse = { delivered: true, roomId: "room-7", botName: "Helper" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(JSON.parse(res.result.content[0].text)).toEqual({ delivered: true, roomId: "room-7" });
    expect(lastAskBody).toMatchObject({ fromBotId: "bot-asker", toBotId: "bot-helper", message: "ping" });
    expect(lastAskBody).not.toHaveProperty("depth");
  });

  it("send_bot_mail returns an asynchronous acknowledgement", async () => {
    const res = await callTool("send_bot_mail", { bot_id: "bot-helper", message: "later" });
    expect(res.result.content[0].text).toContain("Delivered to bot-helper");
    expect(res.result.content[0].text).toContain("do not wait or resend");
    expect(lastActionBody).toMatchObject({
      fromBotId: "bot-asker",
      action: "mail.send",
      toBotId: "bot-helper",
      message: "later",
    });
  });

  it("reads unread room messages through the local action API", async () => {
    const res = await callTool("read_bot_mail", {});
    expect(res.result.content[0].text).toContain("No unread room messages");
    expect(lastActionBody).toMatchObject({ fromBotId: "bot-asker", action: "mail.inbox" });
  });

  // Busy is not a refusal any more: the harness steers or queues, so the tool
  // just reports the delivery. Only a real refusal comes back as an error, and
  // it carries the harness's own "do not retry" prose to the model.
  it("surfaces a harness refusal as a tool error, verbatim", async () => {
    askResponse = { error: "Conversation budget spent (24 messages) - wrap up and report to the user. Do not retry." };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Do not retry");
  });

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "made_up", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });

  it("requires bot_id and message", async () => {
    const res = await callTool("ask_bot", { bot_id: "", message: "" });
    expect(res.result.isError).toBe(true);
  });

  // multibot: skarga właściciela — "poprzednia rutyna co 15 minut nadal działa,
  // narzędzie pozwala tworzyć rutyny, ale nie edytować ani wyłączać; obie wersje
  // chodzą teraz". Pełna pętla przez powierzchnię MCP: załóż → wyłącz → sprawdź
  // na liście → skasuj → lista pusta.
  it("bot can create, disable and delete its own routines", async () => {
    routines = [];
    nextRoutineId = 1;

    const created = JSON.parse((await callTool("create_routine", { name: "Co 15 minut", prompt: "sprawdź pocztę", schedule: "every 15m" })).result.content[0].text);
    expect(created.id).toBe("r1");
    expect(created.enabled).toBe(true);

    const updated = await callTool("update_routine", { id: created.id, enabled: false, schedule: "every 1h" });
    expect(updated.result.isError).toBeFalsy();
    expect(lastActionBody).toMatchObject({ fromBotId: "bot-asker", action: "routines.update", id: "r1", enabled: false, schedule: "every 1h" });

    const listed = JSON.parse((await callTool("list_routines", {})).result.content[0].text);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "r1", enabled: false, schedule: "every 1h" });

    const deleted = await callTool("delete_routine", { id: created.id });
    expect(deleted.result.content[0].text).toContain('"ok": true');
    expect(lastActionBody).toMatchObject({ action: "routines.delete", id: "r1" });

    expect(JSON.parse((await callTool("list_routines", {})).result.content[0].text)).toEqual([]);
  });

  it("routes full bot lifecycle fields through the management API", async () => {
    await callTool("create_agent", {
      name: "Researcher",
      description: "Find evidence",
      color: "purple",
      mascotShape: "star",
      avatarUrl: "https://example.com/avatar.webp",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    });
    expect(lastActionBody).toMatchObject({
      fromBotId: "bot-asker",
      action: "agent.create",
      name: "Researcher",
      color: "purple",
      mascotShape: "star",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    });

    await callTool("get_agent", { bot_id: "bot-helper" });
    expect(lastActionBody).toMatchObject({ action: "agent.get", bot_id: "bot-helper" });

    await callTool("update_agent", { bot_id: "bot-helper", patch: { title: "Lead researcher", color: "cyan", avatarUrl: null } });
    expect(lastActionBody).toMatchObject({ action: "agent.update", bot_id: "bot-helper", patch: { title: "Lead researcher", color: "cyan", avatarUrl: null } });

    await callTool("delete_agent", { bot_id: "bot-helper" });
    expect(lastActionBody).toMatchObject({ action: "agent.delete", bot_id: "bot-helper" });
  });

  // multibot: bot→user file sending — the `send_file` tool lands on the
  // harness attachment endpoint with the bot id and base64 content.
  it("send_file posts the file to the chat attachment endpoint", async () => {
    const html = "<h1>hi</h1>";
    const res = await callTool("send_file", { name: "report.html", mime: "text/html", content_base64: Buffer.from(html).toString("base64") });
    expect(res.result.content[0].text).toContain("File sent to the chat");
    expect(lastAttachmentBody).toMatchObject({ botId: "bot-asker", name: "report.html", mime: "text/html" });
    expect(Buffer.from(lastAttachmentBody.content, "base64").toString()).toBe(html);
  });
});
