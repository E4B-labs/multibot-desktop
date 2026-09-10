// multibot (F7): rejestr własnych serwerów MCP + wspólny montaż mcpServers.
// Store to `~/.multibot/config.json` — testowy HOME jest jednorazowy
// (server/testing/setup.ts), więc round-trip idzie po PRAWDZIWYM pliku.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, loadConfig } from "./config.ts";
import { connectorCards, connectors, recordProbe, removeConnector, saveConnector } from "./mcp-connectors.ts";
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

  // Licznik narzędzi jest wyłącznie SERWEROWY: bierze się z udanej sondy
  // (`POST /api/connectors/custom/:id/test`), a nie z tego, co przyśle panel.
  it("caches the probed tool count and shows it on the card", () => {
    saveConnector("echo", STDIO);
    expect(connectorCards()[0].tools).toBeUndefined();

    recordProbe("echo", 7);
    expect(diskConfig().mcpConnectors.echo).toMatchObject({ name: "Echo", transport: STDIO.transport, tools: 7 });
    expect(connectors()[0]).toMatchObject({ tools: 7 });
    expect(typeof connectors()[0].checkedAt).toBe("number");
    expect(connectorCards()).toEqual([
      { slug: "echo", label: "Echo", blurb: "stdio: node echo.mjs", logo: null, tools: 7 },
    ]);

    // sam zapis (rename) nie gubi ani licznika, ani transportu
    const renamed = saveConnector("echo", { ...STDIO, name: "Echo 2" });
    expect(renamed).toMatchObject({ name: "Echo 2", transport: STDIO.transport, tools: 7 });
    expect(diskConfig().mcpConnectors.echo).toMatchObject({ name: "Echo 2", transport: STDIO.transport, tools: 7 });

    recordProbe("nie-ma-takiego", 3); // no-op, nie tworzy wpisu
    expect(Object.keys(diskConfig().mcpConnectors)).toEqual(["echo"]);
  });

  it("drops the cached count when the transport changes", () => {
    saveConnector("echo", STDIO);
    recordProbe("echo", 7);

    const moved = saveConnector("echo", { name: "Echo", transport: { ...STDIO.transport, args: ["inny.mjs"] } });
    expect(moved.tools).toBeUndefined();
    expect(diskConfig().mcpConnectors.echo.tools).toBeUndefined();
    expect(diskConfig().mcpConnectors.echo.checkedAt).toBeUndefined();
    expect(connectorCards()[0].tools).toBeUndefined();
  });

  it("refuses a tool count injected through the HTTP payload", () => {
    // `decodeConnector` czyta wyłącznie `name` i `transport` — wsad z panelu
    // nie ma jak podstawić „999 narzędzi" pod konektor, którego nikt nie odpytał.
    const saved = saveConnector("echo", { ...STDIO, tools: 999, checkedAt: 1 });
    expect(saved.tools).toBeUndefined();
    expect(diskConfig().mcpConnectors.echo).toEqual({ name: "Echo", transport: STDIO.transport });

    recordProbe("echo", 2);
    // …i nadpisanie z ciałem HTTP też go nie podbije
    expect(saveConnector("echo", { ...STDIO, tools: 999 }).tools).toBe(2);
    expect(diskConfig().mcpConnectors.echo.tools).toBe(2);
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
