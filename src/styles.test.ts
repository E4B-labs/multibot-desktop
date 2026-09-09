import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// multibot: styles.css niosło ~555 linii martwej animacji maskotki — pełny
// silnik maskotki (bevel, orbity, wstążki, konfetti, dymki peer-chat) z czasów,
// gdy maskotka była rysowana CSS-em. Dziś rysuje ją inline SVG w BlobAvatar,
// a peer-chat nie istnieje. Nikt tego nie zauważył, bo martwego CSS-a nic nie
// pilnuje: nie ma go w typach, w testach, ani w buildzie.
//
// Ten test jest tą pilnującą: klasa zadeklarowana w arkuszu musi mieć trafienie
// w źródłach. Zakres celowo wąski (prefiksy, które już raz zgniły), żeby nie
// walczyć z klasami składanymi dynamicznie.
const src = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const DEAD_PREFIXES = ["peer-chat"];

/** Wszystkie pliki .ts/.tsx pod src/, płasko po katalogach. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sources(`${path}/`);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const code = sources(src)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

/** Nazwy klas z selektorów arkusza (bez zmiennych `--color-*`). */
function declaredClasses(prefix: string): string[] {
  const names = new Set<string>();
  for (const match of css.matchAll(new RegExp(`\\.(${prefix}[\\w-]*)`, "g"))) names.add(match[1]);
  return [...names];
}

describe("styles.css nie trzyma martwych klas maskotki", () => {
  it.each(DEAD_PREFIXES)("żadna klasa %s nie została w arkuszu bez użycia", (prefix) => {
    const orphans = declaredClasses(prefix).filter((name) => !code.includes(name));
    expect(orphans, `martwe klasy w styles.css: ${orphans.join(", ")}`).toEqual([]);
  });

  it("czyta prawdziwy arkusz i prawdziwe źródła", () => {
    expect(css.length).toBeGreaterThan(1_000);
    expect(code).toContain("BotAvatar");
  });
});
