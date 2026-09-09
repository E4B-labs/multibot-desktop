import { describe, expect, it } from "vitest";
import {
  CELEBRATE_MS,
  BOT_COLORS,
  BOT_COLOR_NAMES,
  MODEL_LOAD_MS,
  pickerAvatarState,
  stripMascotState,
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
  extra: { runtime?: RuntimePhase | null; streaming?: boolean; focused?: boolean; now?: number } = {},
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
    // rozstrzygnięte narzędzie już nie leci
    expect(strip({ busy: true, messages: [activity(NOW, true)] })).toBeNull();
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
    expect(strip({}, { runtime: { at: NOW, kind: "text" } })).toBe("thinking-dots");
    expect(strip({}, { streaming: true })).toBe("thinking-dots");
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

  it("8. nieprzeczytane liczy się tylko przy oknie w tle", () => {
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

  it("sam `busy` nie zajmuje paska", () => {
    expect(strip({ busy: true })).toBeNull();
    expect(strip({})).toBeNull();
  });
});

describe("paleta maskotki", () => {
  it("BOT_COLORS pokrywa całą allowlistę nazw", () => {
    expect(Object.keys(BOT_COLORS).sort()).toEqual([...BOT_COLOR_NAMES].sort());
    for (const name of BOT_COLOR_NAMES) expect(BOT_COLORS[name]).toMatch(/^#[0-9A-Fa-f]{6}$/);
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
