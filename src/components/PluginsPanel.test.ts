// multibot: nakładka z wtyczkami — „X" i odświeżanie w jej nagłówku nie
// reagowały w spakowanej aplikacji (Kacper, 0.5.33). Winne były DWIE rzeczy,
// więc obie mają tu swój test:
//
//  1. Okno bez ramki. `.multibot-frameless [data-shell-header]` robi z górnego
//     rzędu uchwyt do przeciągania okna, a nakładka nie mówiła o regionie nic —
//     Chromium zostawiał wtedy w tym miejscu `drag` spod spodu (liczy się
//     kolejność w drzewie, patrz WindowControls.test.ts) i klik szedł
//     w przesuwanie okna zamiast w przycisk. Od 0.5.34 nakładka zaczyna się
//     PONIŻEJ tych 72 px i dodatkowo sama jest `no-drag`.
//  2. Sama ikona odświeżania wołała `refreshStatus` po slugach kart AKTUALNIE
//     WIDOCZNYCH. Przy wpisanej frazie albo pustym katalogu ta lista jest
//     pusta, `refreshStatus` wychodzi pierwszą linią i klik nie robił nic —
//     nawet ikona nie kręciła się. Teraz idzie pełny `loadCatalog`.
//
// Vitest chodzi w node bez jsdom (tak samo jak ResizablePanel.test.ts
// i WindowControls.test.ts), więc sprawdzamy źródło — bo to ono się zepsuło.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("./PluginsPanel.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
// Nagłówek modala: od jego rzędu do pola „Szukaj" pod nim.
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
const header = cut(panel, 'className="flex items-center gap-3"', 'placeholder={polish ? "Szukaj');

describe("nakładka na całą powłokę nie wchodzi w pas tytułowy okna", () => {
  it("styles.css spycha każdą nakładkę poniżej 72 px i zdejmuje jej region drag", () => {
    // Odstęp od góry jest właściwą poprawką: przyciski modala przestają leżeć
    // w pasie z `drag`, niezależnie od szerokości okna i szerokości modala.
    expect(styles).toMatch(/\.multibot-frameless \[data-shell-overlay\]\s*{\s*padding-top:\s*72px/);
    expect(styles).toMatch(/\.multibot-frameless \[data-shell-overlay\]\s*{\s*-webkit-app-region:\s*no-drag/);
  });

  it("KAŻDA nakładka na całą powłokę ma atrybut, nie tylko ta z wtyczkami", () => {
    // Pułapka jest w kształcie „`inset-0` nad nagłówkiem", nie w tym jednym
    // pliku. Najgorzej miał pełny ekran podglądu komputera: przy `p-[5%]`
    // jego „X" wypada na ~53-79 px, czyli w środku pasa przeciągania.
    // Ten test jest po to, żeby SIÓDMA nakładka nie wjechała bez atrybutu.
    // Onboarding stoi ZAMIAST powłoki (App.tsx zwraca go, zanim powstanie
    // `.multibot-shell`), więc `.multibot-frameless` nigdy go nie widzi —
    // atrybut byłby tam martwy.
    const overlays = readdirSync(new URL(".", import.meta.url))
      .filter((f) => f.endsWith(".tsx") && f !== "Onboarding.tsx")
      .flatMap((f) => {
        const source = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
        // Nakładka = `fixed`/`absolute inset-0` z własnym z-indexem. Podkłady
        // wewnątrz kafelka (`pointer-events-none`, ikony) odpadają: nie łapią
        // kliknięć, więc region przeciągania ich nie dotyczy.
        return [...source.matchAll(/<(\w+)\s([^>]*?(?:fixed|absolute) inset-0[^>]*?)>/gs)]
          // Komentarze W ŚRODKU znacznika lecą precz, zanim cokolwiek
          // sprawdzimy: bez tego `data-shell-overlay` opisane w komentarzu
          // nad atrybutem zaliczałoby test za sam atrybut.
          .map(([, , attrs]) => ({ file: f, attrs: attrs.replace(/^\s*\/\/.*$/gm, "") }))
          .filter(({ attrs }) => /\bz-\[?\d/.test(attrs) && !attrs.includes("pointer-events-none"));
      });
    expect(overlays.length, "wzorzec przestał cokolwiek łapać").toBeGreaterThan(4);
    for (const { file, attrs } of overlays) {
      expect(attrs, `${file}: nakładka bez data-shell-overlay`).toContain("data-shell-overlay");
    }
  });

  it("odstęp nie zależy od szerokości okna ani od szerokości modala", () => {
    // Poprzednie podejście rezerwowało 114 px w NAGŁÓWKU modala. Działało przy
    // 1440 px i zostawiało 114 px dziury przy 2560 px, a dla węższego modala
    // (mapa zespołu, 880 px) potrzebowałoby własnej stałej. Odstęp od góry nie
    // ma tego problemu — i nie może wrócić pod media query.
    expect(styles).not.toContain("data-shell-overlay-header");
    expect(panel).not.toContain("data-shell-overlay-header");
    // Reguła stoi w płaskim arkuszu, nie w media query: między nią a końcem
    // bloku frameless nie ma otwierającego `@media`.
    const frameless = cut(styles, ".multibot-frameless [data-shell-overlay] { padding-top", "/* multibot: G5");
    expect(frameless).not.toContain("@media");
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

  it("ma jednego właściciela — `refreshStatus` ikony nie dotyka", () => {
    // `refreshStatus` woła też odpytywanie po OAuth (co 5 s przez minutę)
    // i połącz/odłącz. Gdyby gasiło `refreshing`, ikona zatrzymywałaby się
    // w środku przeładowania katalogu, a `disabled` blokowałoby przycisk na
    // czas cudzego obiegu.
    const status = cut(panel, "const refreshStatus", "const loadCatalog");
    expect(status).not.toContain("setRefreshing");
  });
});
