// multibot (A2): wyliczenie narzędzi w prompcie musi być mirrorem prawdziwego
// serwera agents — stąd test czytający źródło z dysku. Lustra serwera MCP
// komputera nie ma, bo sam serwer zniknął razem z silnikiem Hermesa.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AGENTS_MCP_TOOLS, turnToolsText } from "./turn-tools.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

describe("turnToolsText", () => {
  it("enumerates computer tools when the computer is mounted", () => {
    const text = turnToolsText({ localComputer: { command: "py" } } as any);
    expect(text).toContain("Computer MCP tools this turn");
    expect(text).toContain("screenshot");
    expect(text).toContain("computer_exec");
    expect(text).not.toContain("Agents/workspace");
  });

  it("enumerates agents tools when the agents server is mounted", () => {
    const text = turnToolsText({ agents: { command: "node" } } as any);
    expect(text).toContain("Agents/workspace MCP tools this turn");
    expect(text).toContain("list_bots");
    expect(text).toContain("get_device_info");
    expect(text).not.toContain("Computer MCP");
  });

  // Regresja: bot dostawał `send_file` jako jedną z dwudziestu czterech nazw
  // w liście i po nią nie sięgał — zapisywał plik i oddawał użytkownikowi samą
  // ścieżkę. Zdanie o dostarczaniu ma być OBOK listy, nie w niej.
  it("tells the bot that a path is not delivery", () => {
    const text = turnToolsText({ agents: { command: "node" } } as any);
    expect(text).toContain("send_file");
    expect(text).toContain("NOT delivery");
  });

  // Regresja (K6): zdanie kazało „zapisz plik, potem podaj `path`", więc bot
  // wołał `Write`, dostawał kartę zgody i tura kończyła się obietnicą bez
  // pliku. Treść, którą bot pisze SAM, ma iść prosto w `content_base64`.
  it("sends self-written content inline instead of through a disk write", () => {
    const text = turnToolsText({ agents: { command: "node" } } as any);
    expect(text).toContain("content_base64");
    expect(text).toContain("do not save it to disk first");
    expect(text).toContain("Never say a file is sent");
    // Zmierzone po tej zmianie: przy `content_base64` model przestal podawac
    // `name` i trzy pliki wyladowaly w czacie jako „file", „file", „file".
    expect(text).toContain("always set `name` with its extension");
  });

  it("says plainly when nothing is mounted", () => {
    const text = turnToolsText({} as any);
    expect(text).toContain("No MCP tools are mounted this turn");
  });

  it("returns empty text for an undefined integrations object", () => {
    expect(turnToolsText(undefined)).toBe("");
  });

  it("mentions composio when present", () => {
    const text = turnToolsText({ composio: { key: "k" } } as any);
    expect(text).toContain("Composio");
  });
});

describe("tool lists mirror their servers", () => {
  it("AGENTS_MCP_TOOLS matches TOOLS in agents-proxy.ts", () => {
    const src = readFileSync(join(SERVER_DIR, "drivers", "agents-proxy.ts"), "utf8");
    const fromSource = [...src.matchAll(/name:\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
    expect(fromSource.length).toBeGreaterThan(10);
    expect([...AGENTS_MCP_TOOLS].sort()).toEqual([...fromSource].sort());
  });
});