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
    // Pozostałe BotAvatar w pliku to ikonki wierszy palety „/" — stoją
    // nieruchomo (bez propa `animated`), więc liczy się właśnie ten prop.
    expect(composer.match(/animated=\{strip/g) ?? []).toHaveLength(1);
    const strip = composer.slice(composer.indexOf("bottom-[calc(100%+8px)]"));
    expect(strip.slice(0, strip.indexOf("</div>")).match(/<BotAvatar/g) ?? []).toHaveLength(1);
  });

  it("nie renderuje już wskaźnika rozmów bot-bot", () => {
    expect(composer).not.toContain("PeerChatIndicator");
  });

  it("stan awatara liczy stripMascotState, nie samo `bot.busy`", () => {
    expect(composer).toContain("stripMascotState(");
    expect(composer).toContain("state={strip ?? lastStrip.current}");
  });

  // Maskotka odmontowana między stanami traci sprężynę silnika i przeskakuje
  // twardo. Pasek zostaje w drzewie, a pojawia się i znika przenikaniem.
  it("nie odmontowuje maskotki — przenika ją opacity", () => {
    expect(composer).not.toContain("{strip && (");
    expect(composer).toContain("transition-opacity");
    expect(composer).toContain('strip ? "opacity-100" : "opacity-0"');
    // pusty pasek stoi zapauzowany, więc nie kręci rAF-a bez powodu
    expect(composer).toContain("animated={strip !== null}");
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
    // K2: reguła celuje w PUDEŁKO pola — od warstwy podświetlenia wzmianek samo
    // `[data-composer-input]` nie jest już dzieckiem rzędu i stara reguła
    // przestawała cokolwiek robić (czyli wracał błąd z 07.09).
    expect(phone).toContain("[data-composer-row] > [data-composer-field] { order: -1; flex-basis: 100%; }");
    expect(composer).toContain('<div data-composer-field className="relative min-w-[8rem] flex-1">');
    expect(phone).toContain("[data-composer-row] > div > button > span { display: none; }");
  });
});

// multibot K2: `@Bot` koloruje się już w pisanej wiadomości. Warstwa pod
// przezroczystym tekstem stoi i upada na metrykach — te trzy rzeczy trzymają je
// równo i każda z nich po cichu psuje pozycję kursora, jeśli zniknie.
describe("podświetlenie wzmianek w composerze", () => {
  const layer = composer.slice(composer.indexOf("function MentionHighlight"), composer.indexOf("// multibot: F8"));

  it("pigułka nie wnosi szerokości i nie ma obwódki", () => {
    expect(layer).toContain("-mx-[1px]");
    expect(layer).toContain("px-[1px]");
    expect(layer, "obwódka stykała się z sąsiednią literą").not.toContain("box-shadow");
  });

  it("kolor bota liczy się z BOT_COLORS i miesza ze skórką jak plakietka #170", () => {
    expect(layer).toContain("style={botChipStyle(bot.color)}");
    expect(composer).toContain('import { botChipStyle } from "./PeerBadge";');
    expect(layer).toContain("text-[var(--bot-ink)]");
    // tlo RZEDU composera (`bg-raised/60`), nie tlo czatu
    expect(layer).toContain("bg-[color-mix(in_oklab,var(--bot)_26%,var(--color-raised))]");
    expect(layer).not.toContain("var(--color-app)");
  });

  it("warstwa i pole mają tę samą typografię, zawijanie i przewijanie", () => {
    expect(layer).toContain("COMPOSER_TYPO");
    expect(layer).toContain("whitespace-pre-wrap break-words");
    expect(composer).toContain("mentionLayerRef.current.scrollTop = e.currentTarget.scrollTop");
    // przezroczysty tekst TYLKO przy wzmiance — bez niej pole zostaje jak było
    expect(composer).toContain('highlightOn ? "text-transparent caret-ink" : "text-ink"');
  });

  it("warstwa jest zamontowana ZAWSZE, widocznoscia steruje opacity", () => {
    // Montowana warunkowo wchodzila ze `scrollTop = 0`, wiec w przewinietym
    // szkicu pierwsza wzmianka siadala o kilka wierszy za wysoko.
    expect(composer).toContain("<MentionHighlight text={text} bots={state.bots} layerRef={mentionLayerRef} visible={highlightOn} />");
    expect(composer).not.toContain("{liveMentions && <MentionHighlight");
    expect(layer).toContain('visible ? "opacity-100" : "opacity-0"');
  });

  it("IME: przez czas komponowania pole maluje litery samo", () => {
    expect(composer).toContain("onCompositionStart={() => setComposing(true)}");
    expect(composer).toContain("onCompositionEnd={() => setComposing(false)}");
    expect(composer).toContain("const highlightOn = liveMentions && !composing;");
  });

  it("pole jest `block`, wiec pudelko ma dokladnie jego wysokosc", () => {
    // textarea jest domyslnie inline-block i zostawiala pod soba 6 px zejscia
    // linii: rzad composera rosl, a warstwa `inset-0` miala inny zakres
    // przewijania niz pole (w maks. przewinietym szkicu byla 6 px wyzej).
    expect(composer).toContain("relative block max-h-64 w-full resize-none");
  });

  it("pudelko pola ma dolna granice szerokosci", () => {
    // powyzej 700 px rzad sie nie zawija, wiec samo `min-w-0` pozwalalo
    // pigulkom scisnac pole dowolnie wasko (blad z 07.09 w innym przebraniu)
    expect(composer).toContain("min-w-[8rem]");
  });

  it("zaznaczenie ma jawne tlo — przy przezroczystym tekscie Chrome nie rysuje pasa", () => {
    const rule = css.slice(css.indexOf("[data-composer-input][data-mentions]::selection"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("background: Highlight;");
    expect(rule.slice(0, rule.indexOf("}"))).toContain("color: HighlightText;");
  });

  it("na serwer leci surowy tekst pola, nie treść warstwy", () => {
    expect(composer).toContain("text: text.trim()");
    expect(layer).not.toContain("setText");
  });
});
