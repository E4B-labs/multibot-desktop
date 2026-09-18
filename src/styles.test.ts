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

// multibot: regresja 0.5.33 — odstęp pod kontrolki okna wybierał panel przez
// `main:last-child`, a nakładka na całą powłokę to `div` doklejony ZA panelami.
// Otwarcie okna wtyczek sprawiało więc, że żaden panel nie był już ostatnim
// dzieckiem i nagłówek pod spodem tracił swoje 114 px: ikony „Bot's computer",
// „Bot routines" i „Bot skills" (1314-1420 px przy oknie 1440) wjeżdżały pod
// kontrolki okna (1337-1440). Nakładka jest półprzezroczysta, więc było to
// widać jako zlepek ikon w prawym górnym rogu.
describe("odstęp pod kontrolki okna przeżywa otwartą nakładkę", () => {
  // Białe znaki znormalizowane: przeformatowanie arkusza nie ma prawa
  // zaczerwienić testu, który pilnuje logiki selektora.
  const flat = css.replace(/\s+/g, " ");

  it("wybiera ostatni panel, a nie ostatnie dziecko", () => {
    expect(flat).not.toContain("> main:last-child > [data-shell-header]");
    expect(flat).toContain(":is(main, aside):not(:has(~ :is(main, aside))) > [data-shell-header]");
  });

  it("i nadal rezerwuje te 114 px", () => {
    // Bez tego sama asercja negatywna przechodzi także po skasowaniu reguły.
    expect(flat).toMatch(/:not\(:has\(~ :is\(main, aside\)\)\) > \[data-shell-header\] { padding-right: 114px/);
  });
});
