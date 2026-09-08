// multibot: paleta "/" — jedyna nietrywialna logika listy to filtr z limitem
// na kategorię. Bez limitu akcje i skille zjadają całą listę i wtyczki, agenci
// ani rutyny nigdy się nie pokazują, więc ten test pilnuje właśnie tego.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  composerPillShape,
  fastModeAvailable,
  reasoningLevels,
  setBotDraft,
  sidePanelOpen,
  slashVisible,
  withCommand,
  type SlashRow,
} from "./Composer";

const row = (kind: SlashRow["kind"], label: string): SlashRow => ({
  id: `${kind}-${label}`,
  label,
  hint: "",
  kind,
});

describe("slashVisible", () => {
  const many: SlashRow[] = [
    ...Array.from({ length: 9 }, (_, i) => row("action", `action-${i}`)),
    row("plugin", "Gmail"),
    row("agent", "Scout"),
    row("routine", "Weekly digest"),
  ];

  it("pokazuje każdą kategorię mimo długiej listy akcji", () => {
    const kinds = new Set(slashVisible(many, "").map((r) => r.kind));
    expect(kinds).toEqual(new Set(["action", "plugin", "agent", "routine"]));
  });

  it("tnie jedną kategorię do pięciu wierszy", () => {
    expect(slashVisible(many, "").filter((r) => r.kind === "action")).toHaveLength(5);
  });

  it("trzyma stałą kolejność kategorii", () => {
    const rows = slashVisible([row("routine", "r"), row("skill", "/s"), row("action", "a")], "");
    expect(rows.map((r) => r.kind)).toEqual(["action", "skill", "routine"]);
  });

  it("dopasowuje skille bez wiodącego ukośnika", () => {
    expect(slashVisible([row("skill", "/add-connector")], "add").map((r) => r.label)).toEqual(["/add-connector"]);
  });

  it("puste zapytanie nie filtruje niczego", () => {
    expect(slashVisible([row("agent", "Scout")], "")).toHaveLength(1);
  });
});

// multibot: wstawianie komendy z palety poleceń. Nietrywialna jest jedna
// decyzja — co zrobić z tekstem, który już jest w composerze.
describe("withCommand", () => {
  it("zachowuje niedokończoną treść jako argumenty komendy", () => {
    expect(withCommand("raport za marzec", "/model")).toBe("/model raport za marzec");
  });

  it("podmienia komendę, gdy treść już nią jest", () => {
    expect(withCommand("/szukaj", "/model")).toBe("/model ");
  });

  it("na pustym composerze zostawia spację na argumenty", () => {
    expect(withCommand("   ", "/model")).toBe("/model ");
  });
});

describe("drafty wiadomości per bot", () => {
  it("zachowuje tekst każdego bota po przełączeniu i czyści tylko wysłany draft", () => {
    let drafts = setBotDraft({}, "bot-a", "wiadomość dla A");
    drafts = setBotDraft(drafts, "bot-b", "wiadomość dla B");

    expect(drafts).toEqual({ "bot-a": "wiadomość dla A", "bot-b": "wiadomość dla B" });

    drafts = setBotDraft(drafts, "bot-a", "");

    expect(drafts).toEqual({ "bot-a": "", "bot-b": "wiadomość dla B" });
  });
});

// multibot: poziom "max" przyjmuje tylko linia 5.6 i GPT-6 Astra; reszta
// dostałaby od CLI błąd, więc lista musi go dla nich uciąć.
describe("reasoningLevels", () => {
  const ids = (model: string) => reasoningLevels(model).map((level) => level.id);

  it("daje max dla gpt-6-astra", () => {
    expect(ids("gpt-6-astra")).toContain("max");
  });

  it("daje max dla linii 5.6", () => {
    expect(ids("gpt-5.6-sol")).toContain("max");
  });

  it("tnie max starszym modelom", () => {
    expect(ids("gpt-5.4")).not.toContain("max");
  });

  it("dla haiku zostawia sam domyślny poziom", () => {
    expect(ids("claude-haiku-4-5")).toEqual(["default"]);
  });
});

// multibot: „Fast mode" (service tier `priority`) ma tylko codex — przełącznik
// pokazany przy Claude czy silniku byłby atrapą, bo te drivery go nie wysyłają.
describe("fastModeAvailable", () => {
  it("daje przełącznik modelom codeksa", () => {
    expect(fastModeAvailable("codex", "gpt-5.6-sol")).toBe(true);
    expect(fastModeAvailable("codex", "gpt-5.5")).toBe(true);
  });

  it("chowa go dla gpt-5.4-mini, który nie ma tieru priority", () => {
    expect(fastModeAvailable("codex", "gpt-5.4-mini")).toBe(false);
  });

  it("chowa go poza codeksem", () => {
    expect(fastModeAvailable("claude", "claude-sonnet-5")).toBe(false);
    expect(fastModeAvailable("openaiCompatible", "gpt-4o")).toBe(false);
    expect(fastModeAvailable(undefined, "gpt-5.6-sol")).toBe(false);
  });
});

// multibot: „max 1 bot nad composerem". Wcześniej pasek rysował gospodarza PLUS
// partnera z PeerChatIndicator, a w grupie dokładało się trzecie oczko — trzy
// maskotki naraz, każda z własną animacją. Testu nie da się postawić na DOM
// (vitest chodzi w node, repo nie ma jsdom), więc pilnujemy źródła.
const composer = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("pasek nad composerem", () => {
  it("ma dokładnie jeden animowany awatar", () => {
    // Pozostałe MausAvatar w pliku to ikonki wierszy palety „/" — stoją
    // nieruchomo (bez propa `animated`), więc liczy się właśnie ten prop.
    expect(composer.match(/^\s*animated\s*$/gm) ?? []).toHaveLength(1);
    const strip = composer.slice(composer.indexOf("{strip && ("));
    expect(strip.slice(0, strip.indexOf("</div>")).match(/<MausAvatar/g) ?? []).toHaveLength(1);
  });

  it("nie renderuje już wskaźnika rozmów bot-bot", () => {
    expect(composer).not.toContain("PeerChatIndicator");
  });

  it("stan awatara liczy stripMascotState, nie samo `bot.busy`", () => {
    expect(composer).toContain("stripMascotState(");
    expect(composer).toContain("state={strip}");
  });
});

// multibot: pigułki composera (rozumowanie, tryb szybki, dostęp) zwijają się do
// samej ikony, kiedy z prawej stoi panel boczny i kolumna czatu jest wąska.
const PANELS_CLOSED = {
  settingsOpen: false,
  inspectorOpen: false,
  computerOpen: false,
  routinesOpen: false,
  skillsOpen: false,
};

describe("zwijanie pigułek composera", () => {
  it("bez panelu pigułki zostają pełne", () => {
    expect(sidePanelOpen(PANELS_CLOSED)).toBe(false);
  });

  it("KAŻDY panel boczny zwija pigułki, nie tylko ustawienia bota", () => {
    for (const key of Object.keys(PANELS_CLOSED) as Array<keyof typeof PANELS_CLOSED>) {
      expect(sidePanelOpen({ ...PANELS_CLOSED, [key]: true })).toBe(true);
    }
  });

  it("zwinięta pigułka to kwadrat 32 px bez paddingu, pełna ma podpis i odstęp", () => {
    expect(composerPillShape(true)).toBe("size-8 justify-center px-0");
    expect(composerPillShape(false)).toBe("h-8 gap-1 px-2");
  });

  it("wszystkie trzy pigułki i rząd używają wspólnego warunku", () => {
    expect(composer).toContain("const pillsCollapsed = sidePanelOpen(state);");
    // Asercje na obecność, nie na globalną liczbę wystąpień: licznik wywracał
    // się przy każdym kolejnym poprawnym użyciu flagi.
    expect(composer).toContain("{!pillsCollapsed && <span>{reasoningLabel}</span>}");
    expect(composer).toContain('{!pillsCollapsed && <span>{polish ? "Szybko" : "Fast"}</span>}');
    expect(composer).toContain("<ComposerAccessPill bot={bot} collapsed={pillsCollapsed} />");
    expect(composer).toContain("{!collapsed && <span>{polish ? ACCESS_LABELS[access].pl");
    // każda z trzech pigułek bierze kształt ze wspólnego helpera
    expect(composer.match(/composerPillShape\((?:pillsCollapsed|collapsed)\)/g) ?? []).not.toHaveLength(0);
    expect(composer).not.toMatch(/className="flex h-8 (?:shrink-0 )?items-center gap-1 rounded-full px-2/);
  });

  it("zwinięta pigułka rozumowania mówi czytnikowi POZIOM, nie samą nazwę pola", () => {
    // aria-label wygrywa nazwę dostępną i spycha `title` do opisu, którego
    // część czytników nie czyta — poziom musi być w obu.
    expect(composer).toContain("const reasoningTitle = `${polish ? \"Rozumowanie\" : \"Reasoning\"}: ${reasoningLabel}`;");
    expect(composer).toContain("aria-label={reasoningTitle}");
    expect(composer).toContain("title={reasoningTitle}");
    // tryb szybki niesie stan w aria-pressed, więc jemu wystarcza stała nazwa
    expect(composer).toContain('aria-label={polish ? "Tryb szybki" : "Fast mode"}');
    expect(composer).toContain("aria-pressed={bot.fastMode === true}");
  });

  it("odstęp w rzędzie composera zszedł do 6 px", () => {
    expect(composer).toContain("flex min-h-12 items-center gap-1.5 rounded-2xl");
    expect(composer).not.toContain("flex min-h-12 items-center gap-2 rounded-2xl");
  });
});

describe("composer na telefonie", () => {
  it("pole tekstowe ma wlasny wiersz, a pigulki traca podpisy ponizej 700 px", () => {
    // Regresja 07.09: rzad byl jednoliniowy, a pigulki `shrink-0` z podpisami
    // zjadaly cala szerokosc — przy 360 px textarea mialo 0 px i na telefonie
    // zostawal sam pasek ikon bez pola do pisania.
    expect(composer).toContain('<div data-composer-row className="relative flex min-h-12');
    const phone = css.slice(css.indexOf("@media (max-width: 700px)"));
    expect(phone).toContain("[data-composer-row] { flex-wrap: wrap; }");
    expect(phone).toContain("[data-composer-row] > [data-composer-input] { order: -1; flex-basis: 100%; }");
    expect(phone).toContain("[data-composer-row] > div > button > span { display: none; }");
  });
});
