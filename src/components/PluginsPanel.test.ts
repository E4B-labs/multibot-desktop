// multibot: nakładka z wtyczkami — „X" i odświeżanie w jej nagłówku nie
// reagowały w spakowanej aplikacji (Kacper, 0.5.33). Winne były DWIE rzeczy,
// więc obie mają tu swój test:
//
//  1. Okno bez ramki. `.multibot-frameless [data-shell-header]` robi z górnego
//     rzędu uchwyt do przeciągania okna, a nakładka nie mówiła o regionie nic —
//     Chromium zostawiał wtedy w tym miejscu `drag` spod spodu (liczy się
//     kolejność w drzewie, patrz WindowControls.test.ts) i klik szedł
//     w przesuwanie okna zamiast w przycisk. Od 0.5.34 nakładki są `no-drag`.
//  2. Sama ikona odświeżania wołała `refreshStatus` po slugach kart AKTUALNIE
//     WIDOCZNYCH. Przy wpisanej frazie albo pustym katalogu ta lista jest
//     pusta, `refreshStatus` wychodzi pierwszą linią i klik nie robił nic —
//     nawet ikona nie kręciła się. Teraz idzie pełny `loadCatalog`.
//
// Vitest chodzi w node bez jsdom (tak samo jak ResizablePanel.test.ts
// i WindowControls.test.ts), więc sprawdzamy źródło — bo to ono się zepsuło.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("./PluginsPanel.tsx", import.meta.url), "utf8");
const teamMap = readFileSync(new URL("./TeamMapPanel.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
// Nagłówek nakładki: od `data-shell-overlay-header` do pola „Szukaj" pod nim.
// `cut` pilnuje, żeby zniknięcie któregoś znacznika padło z nazwą tego
// znacznika, a nie cichym pustym wycinkiem, na którym każde `toContain`
// przechodzi w drugą stronę.
function cut(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  if (start < 0) throw new Error(`znacznik "${from}" zniknął ze źródła`);
  if (end <= start) throw new Error(`znacznik "${to}" nie stoi po "${from}"`);
  return source.slice(start, end);
}
const header = cut(panel, "data-shell-overlay-header", 'placeholder={polish ? "Szukaj');

describe("nakładka na całą powłokę nie jest uchwytem do przeciągania okna", () => {
  it("styles.css zdejmuje region drag z każdej nakładki", () => {
    expect(styles).toMatch(/\.multibot-frameless \[data-shell-overlay\]\s*{\s*-webkit-app-region:\s*no-drag/);
  });

  it("nakładka trzyma `data-shell-overlay` na tym samym elemencie co `inset-0`", () => {
    // Atrybut na wewnętrznym oknie modala nie wystarczy: region `drag` spod
    // spodu idzie przez CAŁĄ szerokość okna, także obok modala.
    for (const [name, source] of [["PluginsPanel", panel], ["TeamMapPanel", teamMap]] as const) {
      const overlay = source.slice(source.indexOf("data-shell-overlay"), source.indexOf("data-shell-overlay") + 400);
      expect(overlay, `${name}: nakładka bez inset-0`).toContain("inset-0");
    }
  });

  it("nagłówek nakładki robi miejsce na kontrolki okna", () => {
    // Kontrolki okna wiszą wyżej (z-90, fixed) i nakładka ich nie zasłania —
    // bez tego odstępu „X" nakładki nachodzi na „zamknij" okna.
    expect(header).toContain("data-shell-overlay-header");
    expect(styles).toMatch(/\[data-shell-overlay-header\]\s*{\s*padding-right:\s*114px/);
  });
});

describe("nagłówek nakładki z wtyczkami", () => {
  it("mowi Wtyczki / Plugins, nie Marketplace", () => {
    expect(header).toContain('polish ? "Wtyczki" : "Plugins"');
    expect(panel).not.toContain(">Marketplace<");
  });

  it("X i odswiezanie to prawdziwe przyciski z etykieta", () => {
    // Samo <svg onClick> jest poza kolejnością tabulacji i nie łapie go
    // wyjątek `no-drag` dla przycisków w nagłówku.
    expect(header).toContain('aria-label={polish ? "Zamknij" : "Close"}');
    expect(header).toContain('aria-label={polish ? "Odśwież" : "Refresh"}');
    expect(header).not.toMatch(/<RefreshCw[^>]*onClick/);
  });

  it("odświeżanie przeładowuje katalog, nie same statusy widocznych kart", () => {
    expect(header).toContain("onClick={() => void loadCatalog()}");
    expect(header).not.toContain("refreshStatus(composioCards");
  });

  it("jeden nagłówek na oba układy — kompaktowy poniżej `md` też ma czym zamknąć", () => {
    // Ten sam plik jedzie do repo mobilnego i poniżej `md` rysuje kompaktowy
    // panel. Sam rząd nagłówka nie może więc chować się za `hidden` ani stać
    // w gałęzi tylko dla dużego okna — inaczej na wąskim ekranie nie ma „X".
    expect(header.slice(0, header.indexOf(">"))).not.toContain("hidden");
    expect(panel).toContain("max-w-[640px]");
    // klik w tło zamyka w obu układach
    expect(panel).toContain('onClick={() => dispatch({ type: "togglePlugins", open: false })}');
  });
});

describe("kręcenie ikoną odświeżania", () => {
  const load = cut(panel, "const loadCatalog", "// Etykieta konta jedzie");

  it("zaczyna się razem z żądaniem i gaśnie dopiero po statusach", () => {
    expect(load).toContain("setRefreshing(true)");
    expect(load).toContain("finally(() => setRefreshing(false))");
    // `return`, nie `void`: inaczej katalog kończy się przed statusami
    // i ikona mruga zamiast kręcić się do końca.
    expect(load).toMatch(/return refreshStatus\(/);
  });
});
