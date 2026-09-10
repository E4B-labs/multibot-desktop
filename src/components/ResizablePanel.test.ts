// multibot: każdy panel boczny obok czatu ciągnie się za krawędź, tak jak szyna
// botów (Kacper 10.09). Vitest chodzi w node bez jsdom, więc liczby sprawdzamy
// na czystych funkcjach, a montaż panelu — na źródle.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_MIN_WIDTH,
  PANEL_MAX_VW,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  panelWidthFromDrag,
  readStoredWidth,
  viewportMaxWidth,
} from "./ResizablePanel";

const clamp = (width: number) => clampPanelWidth(width, PANEL_MIN_WIDTH, 900);

describe("clamp szerokości panelu", () => {
  it("trzyma się między min a max i zaokrągla do piksela", () => {
    expect(clamp(120)).toBe(PANEL_MIN_WIDTH);
    expect(clamp(360.4)).toBe(360);
    expect(clamp(4000)).toBe(900);
  });

  it("max poniżej min nie wywraca zakresu — wygrywa min", () => {
    expect(clampPanelWidth(500, 280, 100)).toBe(280);
  });

  it("śmieci z localStorage nie ustawiają NaN-owej szerokości", () => {
    expect(clamp(Number.NaN)).toBe(PANEL_MIN_WIDTH);
    expect(clamp(Number.POSITIVE_INFINITY)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("ciągnięcie za krawędź", () => {
  it("uchwyt po lewej rośnie w lewo, po prawej w prawo", () => {
    expect(panelWidthFromDrag(360, -80, "left", clamp)).toBe(440);
    expect(panelWidthFromDrag(360, 80, "left", clamp)).toBe(280);
    expect(panelWidthFromDrag(360, 80, "right", clamp)).toBe(440);
    expect(panelWidthFromDrag(360, -80, "right", clamp)).toBe(280);
  });

  it("ciągnięcie poza zakres zatrzymuje się na granicy", () => {
    expect(panelWidthFromDrag(360, -5000, "left", clamp)).toBe(900);
    expect(panelWidthFromDrag(360, 5000, "left", clamp)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("górna granica z okna", () => {
  it("to 60% szerokości okna, dopóki czatowi zostaje jego podłoga", () => {
    // 1600 → 60% = 960, a po podłodze czatu zostałoby 1120. Wygrywa 960.
    expect(viewportMaxWidth(PANEL_MIN_WIDTH, 1600)).toBe(Math.round(1600 * PANEL_MAX_VW));
  });

  it("w wąskim oknie ustępuje podłodze czatu — 60% byłoby za dużo", () => {
    // Minimalne okno Electrona to 900 px: 60% = 540, ale czat ma zostać nie
    // węższy niż CHAT_MIN_WIDTH, więc panel kończy się na 420.
    expect(viewportMaxWidth(PANEL_MIN_WIDTH, 900)).toBe(900 - CHAT_MIN_WIDTH);
    expect(viewportMaxWidth(PANEL_MIN_WIDTH, 900)).toBeLessThan(Math.round(900 * PANEL_MAX_VW));
  });

  it("okno węższe niż podłoga czatu: max spada do min, clamp ma zakres", () => {
    expect(viewportMaxWidth(PANEL_MIN_WIDTH, 400)).toBe(PANEL_MIN_WIDTH);
    expect(viewportMaxWidth(PANEL_MIN_WIDTH, 0)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("zapamiętana szerokość", () => {
  const withWindow = (store: Record<string, string>, getItem?: () => never) => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: getItem ?? ((key: string) => (key in store ? store[key] : null)),
      },
    };
  };
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("czyta i domyka zapisaną wartość", () => {
    withWindow({ "multibot.panelWidth.skills": "5000" });
    expect(readStoredWidth("multibot.panelWidth.skills", 360, clamp)).toBe(900);
  });

  it("brak wpisu, pusty wpis i tekst dają wartość domyślną", () => {
    withWindow({ "multibot.panelWidth.skills": "   ", "multibot.panelWidth.routines": "abc" });
    expect(readStoredWidth("multibot.panelWidth.skills", 360, clamp)).toBe(360);
    expect(readStoredWidth("multibot.panelWidth.routines", 360, clamp)).toBe(360);
    expect(readStoredWidth("multibot.panelWidth.nieznany", 360, clamp)).toBe(360);
  });

  it("storage rzucający wyjątkiem (tryb prywatny) nie wywraca panelu", () => {
    withWindow({}, () => {
      throw new Error("SecurityError");
    });
    expect(readStoredWidth("multibot.panelWidth.skills", 360, clamp)).toBe(360);
  });

  it("bez window (SSR / test w node) zwraca domyślną", () => {
    expect(readStoredWidth("multibot.panelWidth.skills", 360, clamp)).toBe(360);
  });
});

describe("panele boczne montowane przez powłokę", () => {
  const read = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");
  const app = read("../App");
  // Każdy panel obok czatu — ten sam zestaw co w App.tsx.
  const panels = [
    "SettingsPanel",
    "InspectorPanel",
    "ComputerPanel",
    "RoutinesPanel",
    "SkillsPanel",
    "GroupMembersPanel",
  ];

  it("App.tsx nie montuje panelu bocznego spoza listy", () => {
    for (const name of panels) expect(app).toContain(`<${name}`);
  });

  it("każdy panel idzie przez SidePanel z własnym kluczem i etykietą", () => {
    const keys = new Set<string>();
    for (const name of panels) {
      const source = read(name);
      expect(source, name).toContain("<SidePanel");
      expect(source, name).toContain('from "./ResizablePanel"');
      const key = source.match(/storageKey="([^"]+)"/)?.[1];
      expect(key, name).toMatch(/^multibot\.panelWidth\./);
      expect(keys.has(key!), `${name}: klucz ${key} użyty dwa razy`).toBe(false);
      keys.add(key!);
      expect(source, name).toMatch(/label=\{polish \?/);
      // Sztywna szerokość na `<aside>` była tym, co blokowało ciągnięcie.
      expect(source, name).not.toContain("<aside");
    }
  });

  it("szyna botów dzieli tę samą mechanikę zamiast własnej kopii", () => {
    const sidebar = read("Sidebar");
    expect(sidebar).toContain("useResizableWidth(SIDEBAR_WIDTH_KEY");
    expect(sidebar).toContain("<ResizeHandle resize={resize} />");
    // Zwijanie do ikon zostaje — szyna wnosi własne domknięcie.
    expect(sidebar).toContain("clamp: clampSidebarWidth");
  });

  it("uchwyt nie jest uchwytem do przeciągania okna bez ramki", () => {
    // `data-shell-header` panelu ma `-webkit-app-region: drag` na całą
    // szerokość i 72 px wysokości (styles.css). Bez `no-drag` i bez kolejności
    // w drzewie góra uchwytu przesuwałaby okno zamiast zmieniać szerokość.
    const shared = read("ResizablePanel");
    expect(shared).toContain('WebkitAppRegion: "no-drag"');
    expect(shared.indexOf("{children}")).toBeLessThan(shared.indexOf("<ResizeHandle resize={resize}"));
    // Układ telefonu (styles.css, max-width: 700px) chowa uchwyt — tam panel
    // zakrywa ekran, a `touch-none` przy krawędzi zjadałoby przewijanie.
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toContain('aside:not(:first-child) > [role="separator"]');
  });

  it("pasek szukania w czacie zostaje bez uchwytu", () => {
    // Kacper: „każdy panel oprócz Znajdź w czacie" — ten leży nad transkryptem.
    expect(read("ChatFindBar")).not.toContain("ResizablePanel");
  });
});
