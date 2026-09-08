// multibot (F7): rejestr własnych serwerów MCP + wspólny montaż mcpServers.
// Store to `~/.openmausbot/config.json` — testowy HOME jest jednorazowy
// (server/testing/setup.ts), więc round-trip idzie po PRAWDZIWYM pliku.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, loadConfig } from "./config.ts";
import { connectorCards, connectors, removeConnector, saveConnector } from "./mcp-connectors.ts";
import { mcpServers } from "./mcp-servers.ts";

const STDIO = { name: "Echo", transport: { type: "stdio", command: "node", args: ["echo.mjs"], env: { TOKEN: "t" } } };
const HTTP = { name: "Firma", transport: { type: "http", url: "https://mcp.firma.dev/mcp", headers: { authorization: "Bearer x" } } };

const diskConfig = () => JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));

beforeEach(() => {
  for (const c of connectors()) removeConnector(c.id);
});

describe("mcp-connectors registry", () => {
  it("round-trips a connector through config.json", () => {
    expect(connectors()).toEqual([]);
    const saved = saveConnector("echo", STDIO);
    expect(saved).toEqual({ id: "echo", name: "Echo", transport: STDIO.transport });

    // store = config.json harnessu, ten sam plik co klucze API (tokeny w env)
    expect(diskConfig().mcpConnectors.echo).toEqual({ name: "Echo", transport: STDIO.transport });
    expect(loadConfig().mcpConnectors?.echo?.transport).toEqual(STDIO.transport);
    expect(connectors()).toEqual([saved]);

    saveConnector("firma", HTTP);
    expect(connectors().map((c) => c.id)).toEqual(["echo", "firma"]); // stabilna kolejność

    // …a odłączenie NAPRAWDĘ znika z pliku (merge po kluczu nie zostawia trupa)
    removeConnector("echo");
    expect(Object.keys(diskConfig().mcpConnectors)).toEqual(["firma"]);
    expect(connectors().map((c) => c.id)).toEqual(["firma"]);
    removeConnector("echo"); // no-op, nie rzuca
  });

  it("keeps the rest of config.json intact", () => {
    saveConnector("echo", STDIO);
    expect(diskConfig().instances ?? null).toEqual(loadConfig().instances ?? null);
    saveConnector("firma", HTTP);
    expect(Object.keys(diskConfig().mcpConnectors).sort()).toEqual(["echo", "firma"]);
  });

  it("rejects ids that would collide, overflow, or need escaping", () => {
    for (const bad of ["Echo", "../etc", "ma spacje", "", "a".repeat(62)]) {
      expect(() => saveConnector(bad, STDIO)).toThrow(/invalid id/);
    }
    // nazwy montowane przez same drivery — konektor po cichu przykryłby integrację
    for (const reserved of ["composio", "computer", "agents", "ogb"]) {
      expect(() => saveConnector(reserved, STDIO)).toThrow(/reserved/);
    }
    expect(connectors()).toEqual([]);
  });

  it("rejects a transport without a command or a usable url", () => {
    expect(() => saveConnector("x", { transport: { type: "stdio" } })).toThrow(/command required/);
    expect(() => saveConnector("x", { transport: { type: "http" } })).toThrow(/url required/);
    expect(() => saveConnector("x", { transport: { type: "http", url: "file:///etc/passwd" } })).toThrow(/http\(s\)/);
  });

  // `domain` z karty wyleciało razem z faviconem z google.com — ikony biorą
  // się teraz z bundla (src/lib/appIcons.ts) albo z monogramu, więc host
  // konektora nie ma już czego karmić.
  it("names the catalog card after the connector", () => {
    saveConnector("echo", STDIO);
    saveConnector("firma", { transport: HTTP.transport }); // bez `name` → id
    expect(connectorCards()).toEqual([
      { slug: "echo", label: "Echo", blurb: "stdio: node echo.mjs", logo: null },
      { slug: "firma", label: "firma", blurb: "http: https://mcp.firma.dev/mcp", logo: null },
    ]);
  });
});

describe("mcp-servers", () => {
  it("builds the mount map from both sources", () => {
    saveConnector("echo", STDIO);
    saveConnector("firma", HTTP);
    const servers = mcpServers({ composio: { key: "ck_test" } });

    expect(Object.keys(servers).sort()).toEqual(["composio", "echo", "firma"]);
    // Composio bez zmian — dokładnie to, co montował driver claude przed F7
    expect(servers.composio).toEqual({
      type: "http",
      url: "https://connect.composio.dev/mcp",
      headers: { "x-consumer-api-key": "ck_test" },
    });
    expect(servers.echo).toEqual({ command: "node", args: ["echo.mjs"], env: { TOKEN: "t" } });
    expect(servers.firma).toEqual({
      type: "http",
      url: "https://mcp.firma.dev/mcp",
      headers: { authorization: "Bearer x" },
    });
  });

  it("mounts custom connectors with no Composio key at all", () => {
    saveConnector("echo", STDIO);
    expect(Object.keys(mcpServers(undefined))).toEqual(["echo"]);
    expect(mcpServers({})).toEqual({ echo: { command: "node", args: ["echo.mjs"], env: { TOKEN: "t" } } });
  });
});
