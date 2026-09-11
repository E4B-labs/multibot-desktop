import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CELEBRATE_MS,
  BOT_COLORS,
  BOT_COLOR_NAMES,
  MODEL_LOAD_MS,
  WRITING_MS,
  activityPhrase,
  pickerAvatarState,
  sidebarAvatarProps,
  stripMascotState,
  toolPhrase,
  type MascotBotProfile,
  type RuntimePhase,
} from "./mascot";
import { EFFECTS } from "@/components/BlobAvatar";

// multibot: pasek nad composerem trzyma DOKŁADNIE jednego animowanego bota, a
// jego stan wybiera tabela priorytetów. Testy idą wiersz po wierszu tabeli, bo
// zepsuć ją najłatwiej przestawieniem dwóch `if`-ów.
const NOW = 1_700_000_000_000;

const bot = (over: Partial<MascotBotProfile> = {}): MascotBotProfile => ({
  name: "Atlas",
  messages: [],
  ...over,
});

const strip = (
  over: Partial<MascotBotProfile> = {},
  extra: { runtime?: RuntimePhase | null; streaming?: boolean; engaged?: boolean; focused?: boolean; now?: number } = {},
) => stripMascotState({ bot: bot(over), now: NOW, ...extra });

const activity = (at: number, ok?: boolean) => ({ kind: "activity", at, tool: { name: "bash", ok } as any });

describe("stripMascotState — tabela stanów paska", () => {
  it("1. otwarta karta pytania → confused", () => {
    expect(strip({ messages: [{ kind: "options", card: { title: "?" } as any }] })).toBe("confused");
    expect(strip({ messages: [{ kind: "secret" }] })).toBe("confused");
  });

  it("1. odpowiedziana albo odrzucona karta już nie pyta", () => {
    expect(strip({ messages: [{ kind: "options", card: { answered: "tak" } }] })).toBeNull();
    expect(strip({ messages: [{ kind: "options", card: { dismissed: true } }] })).toBeNull();
    expect(strip({ messages: [{ kind: "secret", secret: { provided: true } }] })).toBeNull();
    expect(strip({ messages: [{ kind: "secret", secret: { dismissed: true } }] })).toBeNull();
  });

  it("1. przejęcie komputera trwa dalej po `takeover`, kończy je dopiero done/skip", () => {
    const card = (answered?: string) => ({
      kind: "options",
      card: { kind: "computer-handoff", ...(answered ? { answered } : {}) },
    });
    expect(strip({ messages: [card("takeover")] })).toBe("confused");
    expect(strip({ messages: [card("done")] })).toBeNull();
    expect(strip({ messages: [card("skip")] })).toBeNull();
  });

  it("2. needsAttention → alerting", () => {
    expect(strip({ needsAttention: "Zaloguj się do Gmaila" })).toBe("alerting");
  });

  it("1 > 2: needsAttention zakończone pytajnikiem to pytanie, nie alarm", () => {
    expect(strip({ needsAttention: "Który klucz mam wziąć? " })).toBe("confused");
  });

  it("3. narzędzie w locie → working, od razu i bez pierścieni", () => {
    expect(strip({}, { runtime: { at: NOW, kind: "tool" } })).toBe("working");
    expect(strip({ busy: true, messages: [activity(NOW)] })).toBe("working");
    // rozstrzygnięte narzędzie już nie leci — ale tura trwa, więc pasek NIE
    // gaśnie, tylko spada na wiersz 8 (żywa tura)
    expect(strip({ busy: true, messages: [activity(NOW, true)] })).toBe("working");
    // porzucona tura nie może trzymać paska na „working" na zawsze — ani przez
    // wiadomość, ani przez fazę `runtime`, której nikt nie kasuje
    expect(strip({ busy: false, messages: [activity(NOW)] })).toBeNull();
    expect(strip({ busy: false }, { runtime: { at: NOW, kind: "tool" } })).toBeNull();
  });

  it("4. rozumowanie → thinking, nigdy loading", () => {
    expect(strip({}, { runtime: { at: NOW, kind: "reasoning" } })).toBe("thinking");
  });

  it("4. świeżo ruszona tura bez tekstu → thinking, nie pierścienie", () => {
    expect(strip({}, { runtime: { at: NOW - MODEL_LOAD_MS + 1, kind: "start" } })).toBe("thinking");
  });

  it("3 > 4: narzędzie wygrywa z rozumowaniem sprzed chwili", () => {
    expect(strip({ busy: true, messages: [activity(NOW)] }, { runtime: { at: NOW, kind: "reasoning" } })).toBe(
      "working",
    );
  });

  it("5. wyjście modelu → thinking-dots (stan silnika, nie nakładka)", () => {
    expect(strip({}, { streaming: true, runtime: { at: NOW, kind: "text" } })).toBe("thinking-dots");
    // …ale tylko dopóki tekst NAPRAWDĘ leci: otwarty strumień bez świeżego
    // kawałka to bot, który dawno przestał pisać i po prostu pracuje.
    expect(strip({}, { streaming: true, runtime: { at: NOW - WRITING_MS - 1, kind: "text" } })).toBe("working");
  });

  it("4 > 5: rozumowanie wygrywa ze strumieniem tekstu", () => {
    expect(strip({}, { runtime: { at: NOW, kind: "reasoning" }, streaming: true })).toBe("thinking");
  });

  it("6. loading (pierścienie) dopiero gdy dostawca milczy MODEL_LOAD_MS", () => {
    const at = NOW - MODEL_LOAD_MS;
    expect(strip({}, { runtime: { at, kind: "start" } })).toBe("loading");
    expect(strip({}, { runtime: { at: at + 1, kind: "start" } })).toBe("thinking");
    // zimny start liczy się tylko przy `start`: każde inne zdarzenie już padło
    expect(strip({}, { runtime: { at, kind: "reasoning" } })).toBe("thinking");
    expect(strip({}, { runtime: { at, kind: "tool" } })).toBe("working");
  });

  it("7. celebrate gaśnie po CELEBRATE_MS", () => {
    expect(strip({}, { runtime: { at: NOW - CELEBRATE_MS + 1, kind: "done" } })).toBe("celebrate");
    expect(strip({}, { runtime: { at: NOW - 1_200, kind: "done" } })).toBeNull();
  });

  it("9. nieprzeczytane liczy się tylko przy oknie w tle", () => {
    expect(strip({ unread: true }, { focused: false })).toBe("notifying");
    expect(strip({ unread: true }, { focused: true })).toBeNull();
  });

  // Skarga właściciela brzmiała „dwie kreski latają wokół bota, gdy myśli" —
  // czyli `loading` (trails: 2 w starym silniku) na wierszu myślenia. Ten test
  // pilnuje, że pierścienie zostają wyłącznie przy zimnym starcie dostawcy.
  it("pierścienie tylko przy zimnym starcie", () => {
    const ringed = (state: ReturnType<typeof strip>) => !!(state && EFFECTS[state]?.trails);
    expect(ringed(strip({}, { runtime: { at: NOW, kind: "reasoning" } }))).toBe(false);
    expect(ringed(strip({}, { runtime: { at: NOW, kind: "tool" } }))).toBe(false);
    expect(ringed(strip({}, { streaming: true }))).toBe(false);
    expect(ringed(strip({}, { runtime: { at: NOW - MODEL_LOAD_MS + 1, kind: "start" } }))).toBe(false);
    expect(ringed(strip({}, { runtime: { at: NOW - MODEL_LOAD_MS, kind: "start" } }))).toBe(true);
  });

  // Faza `runtime` przeżywa turę, więc KAŻDY wiersz, który ją czyta, musi
  // najpierw sprawdzić, czy tura żyje. Tura ubita w środku (runtime.error,
  // przerwanie, watchdog) zostawia ostatnią fazę na zawsze — a odkąd skończone
  // narzędzie wraca na `reasoning`, tą zamrożoną fazą bywa właśnie `reasoning`.
  it("martwa tura nie trzyma paska na żadnej ze swoich faz", () => {
    for (const kind of ["tool", "reasoning", "text", "start"] as const) {
      expect(strip({ busy: false }, { runtime: { at: NOW, kind } })).toBeNull();
    }
    expect(strip({ busy: false }, { streaming: true })).toBeNull();
    // ta sama faza przy żywej turze wciąż zajmuje pasek
    for (const kind of ["tool", "reasoning", "text", "start"] as const) {
      expect(strip({ busy: true }, { runtime: { at: NOW, kind } })).not.toBeNull();
    }
  });

  // Skarga właściciela (19:30): „bot mieli narzędzia, a maskotki nad paskiem nie
  // ma". Wiersz 8 jest odpowiedzią — dopóki serwer trzyma turę otwartą, pasek
  // stoi, choćby nie było ani jednego eventu `runtime`.
  it("8. żywa tura zawsze zajmuje pasek, nawet bez zdarzeń runtime", () => {
    expect(strip({ busy: true })).toBe("working");
    expect(strip({ busy: true }, { runtime: null })).toBe("working");
    // koniec tury bierze się WYŁĄCZNIE z serwera (`busy:false`)
    expect(strip({ busy: false })).toBeNull();
    expect(strip({})).toBeNull();
  });

  it("tabela: narzędzie → working, tekst → thinking-dots, sama tura → working", () => {
    const cases: Array<[string, ReturnType<typeof strip>, string | null]> = [
      ["narzędzie w locie", strip({ busy: true }, { runtime: { at: NOW, kind: "tool" } }), "working"],
      ["pisze teraz", strip({ busy: true }, { streaming: true, runtime: { at: NOW, kind: "text" } }), "thinking-dots"],
      // `streaming` wisi az do settlujacego sie dymka, wiec sam z siebie nie
      // znaczy "pisze": bez swiezego kawalka tekstu bot po prostu pracuje dalej.
      ["strumien otwarty, ale cisza", strip({ busy: true }, { streaming: true, runtime: { at: NOW - WRITING_MS - 1, kind: "text" } }), "working"],
      ["strumien bez fazy tekstu", strip({ busy: true }, { streaming: true }), "working"],
      ["faza text bez strumienia", strip({ busy: true }, { runtime: { at: NOW, kind: "text" } }), "working"],
      ["myśli", strip({ busy: true }, { runtime: { at: NOW, kind: "reasoning" } }), "thinking"],
      ["między narzędziami", strip({ busy: true }, { runtime: { at: NOW, kind: "reasoning" } }), "thinking"],
      ["tura bez zdarzeń", strip({ busy: true }), "working"],
      ["po końcu tury", strip({ busy: false }, { runtime: { at: NOW - 2 * CELEBRATE_MS, kind: "done" } }), null],
    ];
    for (const [name, got, want] of cases) expect([name, got]).toEqual([name, want]);
  });

  // Odmontowanie maskotki zabija sprężynę silnika, więc każda dziura w tej
  // sekwencji to widoczny przeskok. Pasek ma NIE gasnąć aż do końca tury.
  it("przez całą turę pasek ani razu nie gaśnie", () => {
    const live: Array<Parameters<typeof strip>[1]> = [
      { runtime: { at: NOW, kind: "start" } },
      { runtime: { at: NOW, kind: "reasoning" } },
      { runtime: { at: NOW, kind: "text" }, streaming: true },
      { runtime: { at: NOW, kind: "text" } }, // blok wypłukany, strumień zamknięty
      { runtime: { at: NOW - WRITING_MS - 1, kind: "text" }, streaming: true }, // tekst ucichł
      { runtime: { at: NOW, kind: "tool" } },
      { runtime: { at: NOW, kind: "reasoning" } }, // narzędzie oddało wynik
      { runtime: { at: NOW, kind: "tool" } },
      {}, // dziura: dostawca milczy, nie przyszedł żaden event
    ];
    for (const extra of live) expect(strip({ busy: true }, extra)).not.toBeNull();
  });

  // Rozmowa bot↔bot: tura kolegi leci na JEGO wątku, więc u oglądanego bota
  // nie ma ani `busy`, ani żadnej fazy `runtime` — i dokładnie tam pasek gasł.
  it("9. wymiana z innym botem → listening, także bez własnej tury", () => {
    expect(strip({ busy: false }, { engaged: true })).toBe("listening");
    expect(strip({}, { engaged: true })).toBe("listening");
  });

  it("9. własna tura w tej rozmowie wygrywa z czekaniem", () => {
    expect(strip({ busy: true }, { engaged: true })).toBe("working");
    expect(strip({ busy: true }, { engaged: true, runtime: { at: NOW, kind: "tool" } })).toBe("working");
  });

  it("9. koniec wymiany gasi pasek, a nie zostawia go na listening", () => {
    expect(strip({ busy: false }, { engaged: false })).toBeNull();
  });

  // Cała wymiana, sekwencja po sekwencji: od chwili gdy kolega dostaje turę, aż
  // do jej końca pasek ani razu nie może być pusty.
  it("przez całą wymianę bot↔bot pasek ani razu nie gaśnie", () => {
    const exchange: Array<[Partial<MascotBotProfile>, Parameters<typeof strip>[1]]> = [
      [{ busy: true }, { engaged: true, runtime: { at: NOW, kind: "tool" } }], // pisze do kolegi
      [{ busy: false }, { engaged: true }], // oddał turę, kolega jeszcze nie zaczął
      [{ busy: false }, { engaged: true }], // kolega pisze
      [{ busy: true }, { engaged: true, runtime: { at: NOW, kind: "start" } }], // wróciło do nas
    ];
    for (const [over, extra] of exchange) expect(strip(over, extra)).not.toBeNull();
  });
});

describe("paleta maskotki", () => {
  it("BOT_COLORS pokrywa całą allowlistę nazw", () => {
    expect(Object.keys(BOT_COLORS).sort()).toEqual([...BOT_COLOR_NAMES].sort());
    for (const name of BOT_COLOR_NAMES) expect(BOT_COLORS[name]).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  // 11 barw w siatce o 7 kolumnach zostawiało trzy dziury w drugim rzędzie.
  // Dwa pełne rzędy to warunek na wygląd panelu, nie kosmetyka testu.
  it("wypełnia dwa rzędy po siedem, w kolejności koła barw", () => {
    const panel = readFileSync(new URL("../components/SettingsPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain("grid-cols-7");
    expect(BOT_COLOR_NAMES.length % 7).toBe(0);
    expect([...BOT_COLOR_NAMES]).toEqual([
      "red", "coral", "orange", "yellow", "lime", "green",
      "teal", "cyan", "blue", "indigo", "purple", "pink",
      "white", "black",
    ]);
  });

  // Dwa nierozróżnialne kółka w siatce to dwa kółka, w które nikt nie celuje.
  // Próg 25 to podłoga wyznaczona przez najbliższą istniejącą parę (red/coral,
  // 27,1) — nowa barwa bliżej czegokolwiek niż to nie jest nową barwą.
  it("żadne dwie barwy nie leżą na sobie", () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    for (const a of BOT_COLOR_NAMES) {
      for (const b of BOT_COLOR_NAMES) {
        if (a >= b) continue;
        const [ar, ag, ab] = rgb(BOT_COLORS[a]);
        const [br, bg, bb] = rgb(BOT_COLORS[b]);
        expect(Math.hypot(ar - br, ag - bg, ab - bb), `${a} vs ${b}`).toBeGreaterThan(25);
      }
    }
  });
});

describe("pickerAvatarState", () => {
  it("keeps a selectable stored face", () => {
    expect(pickerAvatarState({ mascotExpression: "curious" })).toBe("curious");
  });

  it("uses a calm picker face for missing, unknown, or transient states", () => {
    expect(pickerAvatarState({ mascotExpression: null })).toBe("happy");
    expect(pickerAvatarState({ mascotExpression: "not-a-state" })).toBe("happy");
    expect(pickerAvatarState({ mascotExpression: "thinking-dots" })).toBe("happy");
  });
});

describe("sidebarAvatarProps — roster shows the live state", () => {
  const b = (over: Partial<MascotBotProfile> = {}): MascotBotProfile => ({ name: "Atlas", messages: [], ...over });

  it("idle bot is idle and still", () => {
    expect(sidebarAvatarProps(b())).toEqual({ state: "idle", motion: "none", animated: false, motionKey: 0 });
  });

  it("busy bot is working and animated; tool in flight too", () => {
    expect(sidebarAvatarProps(b({ busy: true }))).toMatchObject({ state: "working", animated: true });
    expect(sidebarAvatarProps(b({ busy: true }), { runtime: { kind: "tool", at: NOW }, now: NOW })).toMatchObject({ state: "working", animated: true });
    expect(sidebarAvatarProps(b({ busy: true }), { runtime: { kind: "reasoning", at: NOW }, now: NOW }).state).toBe("thinking");
  });

  it("finished turn returns to idle", () => {
    expect(sidebarAvatarProps(b({ busy: false }), { runtime: { kind: "done", at: NOW - CELEBRATE_MS }, now: NOW }).state).toBe("idle");
  });
});

describe("toolPhrase — never the raw tool name", () => {
  it("maps the common tools to sentences, in both languages", () => {
    expect(toolPhrase("Bash")).toBe("Runs a command");
    expect(toolPhrase("Bash", "pl")).toBe("Uruchamia polecenie");
    expect(toolPhrase("git status && npm test")).toBe("Runs a command");
    expect(toolPhrase("Read")).toBe("Reads files");
    expect(toolPhrase("Edit", "pl")).toBe("Edytuje pliki");
    expect(toolPhrase("edit")).toBe("Edits files");
    expect(toolPhrase("WebSearch")).toBe("Searches the web");
    expect(toolPhrase("web_search", "pl")).toBe("Szuka w sieci");
    expect(toolPhrase("WebFetch")).toBe("Reads a web page");
    expect(toolPhrase("Agent")).toBe("Delegates a task");
    expect(toolPhrase("Skill")).toBe("Uses a skill");
    expect(toolPhrase("mcp__computer__navigate")).toBe("Browses the web");
    expect(toolPhrase("mcp__computer__navigate", "pl")).toBe("Przegląda internet");
    expect(toolPhrase("mcp__computer__screenshot")).toBe("Looks at the screen");
    expect(toolPhrase("mcp__computer__read_page", "pl")).toBe("Patrzy na ekran");
    expect(toolPhrase("mcp__computer__click")).toBe("Uses the computer");
    expect(toolPhrase("mcp__agents__ask_bot")).toBe("Asks a colleague");
    expect(toolPhrase("mcp__github__create_issue")).toBe("Uses github");
    expect(toolPhrase("error: boom")).toBe("Hit an error");
  });

  it("unknown names fall back to a generic sentence, never the name", () => {
    for (const name of ["frobnicate_widgets", "XyzThing", "mystery"]) {
      expect(toolPhrase(name)).toBe("Uses a tool");
      expect(toolPhrase(name, "pl")).toBe("Używa narzędzia");
      expect(toolPhrase(name)).not.toContain(name);
    }
  });
});

describe("activityPhrase — what the bot does now", () => {
  const b = (over: Partial<MascotBotProfile> = {}): MascotBotProfile => ({ name: "Atlas", messages: [], ...over });

  it("idle bot has no phrase", () => {
    expect(activityPhrase(b())).toBeNull();
  });

  it("tool in flight → the tool sentence; finished tool → generic work", () => {
    expect(activityPhrase(b({ busy: true, messages: [activity(NOW)] }))).toBe("Runs a command");
    expect(activityPhrase(b({ busy: true, messages: [{ kind: "activity", at: NOW, tool: { name: "Screen frame" } } as any] }), {}, "pl")).toBe("Patrzy na ekran");
    expect(activityPhrase(b({ busy: true, messages: [activity(NOW, true)] }))).toBe("Works on it");
    expect(activityPhrase(b({ busy: true, messages: [{ kind: "screen", at: NOW }] }))).toBe("Looks at the screen");
  });

  it("follows the turn phase and the waiting states", () => {
    expect(activityPhrase(b({ busy: true }), { runtime: { kind: "reasoning", at: NOW }, now: NOW })).toBe("Thinks");
    expect(activityPhrase(b({ busy: true }), { runtime: { kind: "reasoning", at: NOW }, now: NOW }, "pl")).toBe("Myśli");
    expect(activityPhrase(b({ busy: true }), { runtime: { kind: "text", at: NOW }, streaming: true, now: NOW })).toBe("Writes a reply");
    expect(activityPhrase(b({ busy: true }), { runtime: { kind: "start", at: NOW - MODEL_LOAD_MS }, now: NOW })).toBe("Warms up the model");
    expect(activityPhrase(b({ messages: [{ kind: "secret" }] }))).toBe("Waits for your answer");
    expect(activityPhrase(b({ needsAttention: "disk full" }), {}, "pl")).toBe("Potrzebuje Twojej uwagi");
    expect(activityPhrase(b(), { runtime: { kind: "done", at: NOW }, now: NOW })).toBe("Just finished");
    expect(activityPhrase(b(), { engaged: true })).toBe("Listens to a colleague");
  });
});
