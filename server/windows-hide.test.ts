import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// multibot: strażnik przed migającymi oknami konsol na Windowsie. Każde
// wywołanie spawn/execFile z node:child_process w kodzie serwera musi dostać
// `windowsHide: true` w opcjach (no-op poza Windows). Bez tej flagi każdy
// spawnowany proces potrafi mignąć oknem konsoli i ukraść fokus użytkownikowi.

const SERVER_DIR = __dirname;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// wywołanie, nie definicja/komentarz: `spawn(`/`execFile(` nie poprzedzone
// literą, kropką ani cudzysłowem (odsiewa resolveCliSpawn(, this.spawnFn(,
// "spawn(" w komentarzach cytujących kod — te i tak łapiemy przez treść opcji)
const CALL = /(?<![A-Za-z0-9_.$"'`])(?:spawn|spawnSync|execFile|execFileSync)\(/g;

describe("windowsHide", () => {
  it("każdy spawn/execFile w server/ ma windowsHide w opcjach", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SERVER_DIR)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("node:child_process")) continue;
      for (const match of text.matchAll(CALL)) {
        const line = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index + 40);
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        // opcje siedzą w tym samym wywołaniu — 600 znaków z zapasem obejmuje
        // każdy obiekt opcji w tym repo
        const snippet = text.slice(match.index, (match.index ?? 0) + 600);
        if (!snippet.includes("windowsHide")) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
