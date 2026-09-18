#!/usr/bin/env node
// Najmniejszy prawdziwy serwer MCP po stdio: JSON-RPC po liniach, jedno
// narzędzie (`echo`). Sonda `server/mcp-probe.ts` gada z NIM, a nie z atrapą
// modułu — inaczej test przechodzi także wtedy, gdy framing jest zły.
//
//   FAKE_MCP_MODE  ok (domyślnie) | one (jedno narzędzie zamiast dwóch)
//                  | mute (żyje, nie odpowiada NIGDY)
//                  | noisy (loguje śmieci po stdout przed odpowiedzią)
//                  | fail (odpowiada błędem JSON-RPC na initialize)
//                  | leak (wypluwa własny token na stderr i pada)
//
// Bez zależności — leci jako goły `node` subprocess.
const mode = process.env.FAKE_MCP_MODE ?? "ok";

if (mode === "leak") {
  process.stderr.write(`boom: bad token ${process.env.SECRET_TOKEN ?? ""}\n`);
  process.exit(3);
}

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

let buffer = "";
process.stdin.on("data", (chunk) => {
  if (mode === "mute") return;
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // regresja framingu w sondzie ma się pokazać jako timeout, a nie jako
      // „server stopped" z atrapy, która sama się wywaliła
      process.stderr.write(`[fake-mcp] not json: ${line.slice(0, 80)}\n`);
      continue;
    }
    if (mode === "noisy") process.stdout.write("[fake-mcp] not json at all\n");
    if (msg.method === "initialize") {
      if (mode === "fail") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "nope, bad auth" } });
      else send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-echo", version: "0.0.1" },
        },
      });
    } else if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: mode === "one"
            ? [{ name: "echo", description: "echoes back", inputSchema: { type: "object" } }]
            : [
              { name: "echo", description: "echoes back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
              { name: "ping", description: "pong", inputSchema: { type: "object" } },
            ],
        },
      });
    }
  }
});
process.stdin.resume();
