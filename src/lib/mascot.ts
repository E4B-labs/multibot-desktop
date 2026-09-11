import { BLOB_STATES, type BlobState } from "@/components/BlobAvatar";
import type { Bot } from "@/state/store";

/** The mascot's behaviour vocabulary — BlobAvatar's 40 states, under the
 * app's historical names. */
export type BotState = BlobState;
export const BOT_STATES = BLOB_STATES;

/** BlobAvatar ships French group labels; the app shows these instead. The
 * memberships mirror its STATE_GROUPS exactly. */
export const STATE_GROUPS: Record<string, BotState[]> = {
  Lifecycle: ["sleeping", "waking", "idle", "listening", "thinking", "searching", "working"],
  Reactions: [
    "excited",
    "surprised",
    "suspicious",
    "angry",
    "drowsy",
    "happy",
    "curious",
    "confused",
    "bored",
    "proud",
    "shy",
    "sad",
    "laughing",
    "scared",
    "playful",
    "celebrate",
  ],
  "Agent morphs": ["orbit", "radar", "progress", "thinking-dots"],
  "Product cycle": [
    "spawning",
    "humming",
    "loading",
    "dictating",
    "writing",
    "sending",
    "receiving",
    "uploading",
    "notifying",
    "alerting",
    "dragging",
    "bouncing",
    "powering-down",
  ],
};

/**
 * Paleta maskotki — 12 barw uporzadkowanych po kole barw (czerwony -> rozowy),
 * na koncu dwa neutralne. Kolejnosc jest kolejnoscia pokazu w ustawieniach:
 * przy 7 kolumnach 14 pozycji wypelnia dokladnie dwa rzedy, bez dziur.
 *
 * multibot: `white`, `black`, `lime` i `indigo` sa wybieralne, ale nie wchodza
 * do rotacji nowych botow (serwerowe COLORS w `server/store.ts`) — bot dostaje
 * je tylko wtedy, gdy ktos je ustawi.
 */
export const BOT_COLOR_NAMES = [
  "red",
  "coral",
  "orange",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "purple",
  "pink",
  "white",
  "black",
] as const;

export type BotColor = (typeof BOT_COLOR_NAMES)[number];

export const BOT_COLORS: Record<BotColor, string> = {
  red: "#D94B52",
  coral: "#E5634E",
  orange: "#E78531",
  yellow: "#D8A729",
  lime: "#8CBF2A",
  green: "#009957",
  teal: "#01A492",
  cyan: "#0EA5C6",
  blue: "#377FE6",
  indigo: "#5B54D6",
  purple: "#8057C8",
  pink: "#D84F8B",
  white: "#F4F4F5",
  black: "#1A1A1A",
};

export const BOT_MOTIONS = [
  "arrive",
  "switch",
  "customize",
  "alert",
  "thinking",
  "working",
  "launch",
  "success",
  "celebrate",
  "blink",
  "surprise",
  "failure",
  "sending",
] as const;

export type BotMotion = "none" | (typeof BOT_MOTIONS)[number];

/** To, co pasek nad composerem wie o turze, a czego nie ma w samym `Bot`. */
export type LiveTurn = Omit<Parameters<typeof stripMascotState>[0], "bot">;

/**
 * Awatar bota poza paskiem nad composerem (roster, nagłówek czatu, wiersz
 * grupy, kafelek hovera): ta sama tabela stanów co pasek (`stripMascotState`),
 * więc zajęty bot pracuje także w rosterze, a bezczynny stoi na „idle".
 *
 * Rusza się wyłącznie bot, z którym coś się dzieje. „notifying" (nieprzeczytane)
 * dostaje minę, ale nie animację — kropka przy wierszu już to mówi, a roster
 * pełen podskakujących botów nie jest subtelny.
 */
export function sidebarAvatarProps(
  bot: MascotBotProfile,
  live: LiveTurn = {},
): { state: BotState; motion: BotMotion; animated: boolean; motionKey: number } {
  const state = stripMascotState({ bot, ...live }) ?? "idle";
  return { state, motion: "none", animated: state !== "idle" && state !== "notifying", motionKey: 0 };
}

type Lang = "en" | "pl";
const t = (lang: Lang, en: string, pl: string) => (lang === "pl" ? pl : en);

/**
 * Nazwa narzędzia (to, co driver wstawia w `activity.tool.name`: `Bash`,
 * `mcp__computer__navigate`, treść komendy z codexa, `edit`, `error: …`) →
 * krótkie zdanie po ludzku. Nigdy nie oddaje surowej nazwy.
 */
export function toolPhrase(name: string, lang: Lang = "en"): string {
  const raw = name.trim();
  const n = raw.toLowerCase();
  if (n.startsWith("error:")) return t(lang, "Hit an error", "Napotkał błąd");
  const mcp = /^mcp__([a-z0-9-]+)__(.+)$/.exec(n);
  if (mcp) {
    const [, server, tool] = mcp;
    if (server === "computer") {
      if (/navigate|open|url|back/.test(tool)) return t(lang, "Browses the web", "Przegląda internet");
      if (/screenshot|read_page|find|screen|page_text/.test(tool)) return t(lang, "Looks at the screen", "Patrzy na ekran");
      return t(lang, "Uses the computer", "Obsługuje komputer");
    }
    if (server === "agents") return t(lang, "Asks a colleague", "Pyta kolegę");
    return t(lang, `Uses ${server.replace(/[-_]+/g, " ")}`, `Używa: ${server.replace(/[-_]+/g, " ")}`);
  }
  if (/^(bash|shell|cmd|powershell|pwsh|sh|zsh|exec|commandexecution)$/.test(n) || /^(bash|sh|pwsh|powershell|cmd|npm|npx|node|git|python|pip|curl|ls|cat|cd|mkdir|rm|grep|find|make|cargo|go|docker)\b/.test(n)) {
    return t(lang, "Runs a command", "Uruchamia polecenie");
  }
  if (/^(read|glob|grep|ls|notebookread)$/.test(n)) return t(lang, "Reads files", "Czyta pliki");
  if (/^(write|edit|multiedit|notebookedit|filechange)$/.test(n)) return t(lang, "Edits files", "Edytuje pliki");
  if (/^(websearch|web_search)$/.test(n)) return t(lang, "Searches the web", "Szuka w sieci");
  if (/^(webfetch|fetch)$/.test(n)) return t(lang, "Reads a web page", "Czyta stronę");
  if (/^(agent|task)$/.test(n)) return t(lang, "Delegates a task", "Zleca zadanie");
  if (/^(ask_bot|askbot)$/.test(n)) return t(lang, "Asks a colleague", "Pyta kolegę");
  if (n === "skill") return t(lang, "Uses a skill", "Używa umiejętności");
  if (/^(todowrite|todo)$/.test(n)) return t(lang, "Plans the work", "Planuje pracę");
  if (/browse|navigate/.test(n)) return t(lang, "Browses the web", "Przegląda internet");
  if (/screen/.test(n)) return t(lang, "Looks at the screen", "Patrzy na ekran");
  return t(lang, "Uses a tool", "Używa narzędzia");
}

/**
 * „Co bot teraz robi" — jedno zdanie do kafelka hovera. `null`, gdy nic:
 * bezczynny bot nie dostaje podpisu. Mina i zdanie pochodzą z tej samej
 * tabeli, więc nigdy nie mówią dwóch różnych rzeczy.
 */
export function activityPhrase(bot: MascotBotProfile, live: LiveTurn = {}, lang: Lang = "en"): string | null {
  const state = stripMascotState({ bot, ...live });
  if (state === null) return null;
  const last = bot.messages?.[bot.messages.length - 1] as (MascotMessage & { tool?: { name?: string } }) | undefined;
  switch (state) {
    case "confused":
      return t(lang, "Waits for your answer", "Czeka na Twoją odpowiedź");
    case "alerting":
      return t(lang, "Needs your attention", "Potrzebuje Twojej uwagi");
    case "working":
      // tylko narzędzie W LOCIE; skończone (ok rozstrzygnięte) już nie mówi, co bot robi
      if (last?.kind === "activity" && last.tool?.name && last.tool.ok === undefined) return toolPhrase(last.tool.name, lang);
      if (last?.kind === "screen") return t(lang, "Looks at the screen", "Patrzy na ekran");
      return t(lang, "Works on it", "Pracuje nad tym");
    case "thinking":
      return t(lang, "Thinks", "Myśli");
    case "thinking-dots":
      return t(lang, "Writes a reply", "Pisze odpowiedź");
    case "loading":
      return t(lang, "Warms up the model", "Rozgrzewa model");
    case "celebrate":
      return t(lang, "Just finished", "Właśnie skończył");
    case "listening":
      return t(lang, "Listens to a colleague", "Słucha kolegi");
    case "notifying":
      return t(lang, "Has something new", "Ma coś nowego");
    default:
      return t(lang, "Works on it", "Pracuje nad tym");
  }
}

/**
 * The face used to be ten hand-drawn SVGs; it is now the engine's 40 states.
 * Bots saved under the old vocabulary still carry one of these ten names, so
 * they are translated on read rather than migrated in place — a bot's stored
 * face should survive a downgrade too.
 */
const LEGACY_STATES: Record<string, BotState> = {
  deadpan: "idle",
  friendly: "happy",
  focused: "working",
  thinking: "thinking",
  excited: "excited",
  sleepy: "drowsy",
  surprised: "surprised",
  skeptical: "suspicious",
  worried: "scared",
  mischievous: "playful",
};

const KNOWN_STATES = new Set<string>(BOT_STATES);

/** Resolves any stored value — current, legacy or junk — to a real state. */
export function normalizeState(value: string | null | undefined): BotState | null {
  if (!value) return null;
  if (KNOWN_STATES.has(value)) return value as BotState;
  return LEGACY_STATES[value] ?? null;
}

/**
 * The states worth offering in the appearance picker.
 *
 * The engine carries 40, but many are transient beats the app drives itself
 * (`sending`, `alerting`, `powering-down`) and make no sense as a bot's resting
 * face. More importantly, states share resting faces: `happy`, `excited` and
 * `playful` all rest on expression 2, and `curious`, `surprised` and `scared`
 * all rest on 3 — they differ in which faces they *drift* to, which a static
 * swatch cannot show. Offering them all gave 15 buttons showing 8 pictures.
 *
 * Across all 40 states there are only 11 distinct resting faces, so this is one
 * state per face, chosen for the clearest name. Every swatch looks different.
 */
export const PICKABLE_STATES: BotState[] = [
  "idle", // expression 0
  "happy", // 2
  "curious", // 3
  "drowsy", // 4
  "working", // 7
  "thinking", // 8
  "listening", // 10
  "sleeping", // 13
  "suspicious", // 14
  "proud", // 15
];

const PICKABLE_STATE_SET = new Set<BotState>(PICKABLE_STATES);

/** Static face for group members, restricted to expressions offered by the picker. */
export function pickerAvatarState(bot: Pick<Bot, "mascotExpression">): BotState {
  const state = normalizeState(bot.mascotExpression);
  return state && PICKABLE_STATE_SET.has(state) ? state : "happy";
}

/**
 * The group reference face: one quiet resting expression for every member,
 * independent of the bot's live or saved expression state.
 */
export const GROUP_AVATAR_STATE: BotState = "happy";

type MascotMessage = {
  kind: string;
  at?: number;
  tool?: { ok?: boolean };
  card?: { kind?: string; answered?: string; dismissed?: boolean };
  secret?: { provided?: boolean; dismissed?: boolean };
};

export type MascotBotProfile = {
  name: string;
  title?: string;
  description?: string;
  mascotExpression?: string | null;
  busy?: boolean;
  unread?: boolean;
  needsAttention?: string | null;
  messages?: MascotMessage[];
};

/**
 * Zimny start: tura ruszyła, a dostawca po tylu milisekundach nadal nie
 * wypuścił ŻADNEGO zdarzenia (ani rozumowania, ani narzędzia, ani tekstu).
 * Dopiero to jest „ładowanie modelu" i tylko to zapala pierścienie.
 */
export const MODEL_LOAD_MS = 10_000;
/** Ile świętujemy koniec tury, zanim bot zejdzie z paska. */
export const CELEBRATE_MS = 1_000;
/**
 * Jak długo po OSTATNIM kawałku tekstu pasek jeszcze „pisze".
 *
 * `streaming` znaczy tylko tyle, że strumień jest niezamknięty — a wisi on aż
 * do settlującego się dymka, czyli zwykle do końca tury. Sam ten warunek
 * trzymał maskotkę na trzech kropkach przez CAŁĄ turę: bot rzucał zdanie, szedł
 * pracować na minutę, a nad composerem stały trzy ledwo widoczne kropki. Stąd
 * skarga „maskotki nie widać, kiedy bot pracuje". Kropki należą się pisaniu na
 * żywo; kiedy tekst przestaje płynąć, ciało wraca i widać, że bot robi swoje.
 */
export const WRITING_MS = 1_500;

/** Faza tury złożona z eventów runtime — patrz `runtime` w store. */
export type RuntimeKind = "start" | "reasoning" | "tool" | "text" | "done";
export type RuntimePhase = { at: number; kind: RuntimeKind };

/** Karta, na którą bot wciąż czeka — pytanie, wybór, sekret albo komputer. */
function pendingAsk(last: MascotMessage | undefined): boolean {
  if (!last) return false;
  if (last.kind === "secret") return !last.secret?.provided && !last.secret?.dismissed;
  if (last.kind !== "options" || !last.card) return false;
  if (last.card.dismissed) return false;
  // Karta przekazania komputera zostaje żywa po „takeover" — człowiek dopiero
  // zaczyna robotę; zamykają ją dopiero „done" i „skip".
  if (last.card.kind === "computer-handoff") return last.card.answered !== "done" && last.card.answered !== "skip";
  return last.card.answered === undefined;
}

/**
 * Jedyny animowany bot w aplikacji: ten na pasku nad composerem. Zwraca stan
 * maskotki albo `null` — wtedy pasek jest pusty i nie ma czego animować.
 *
 * Kolejność wierszy jest tabelą priorytetów, pierwsze dopasowanie wygrywa:
 * 1-2 pytanie/uwaga > 3 narzędzie > 4 myślenie > 5 pisanie > 6 zimny start >
 * 7 sukces > 8 ŻYWA TURA > 9 ROZMOWA Z BOTEM > 10 nieprzeczytane.
 *
 * `bot.busy` jest ostatnią deską ratunku, nie ozdobą: dopóki serwer trzyma turę
 * otwartą, pasek MUSI stać i się ruszać, choćby nie przyszło ani jedno
 * zdarzenie `runtime` (starszy serwer, strona przeładowana w środku tury, dziura
 * między dwoma narzędziami). Gasi go wyłącznie realny koniec tury z serwera —
 * `turn.completed`, `runtime.error` albo watchdog — bo każdy z nich zdejmuje
 * `busy`. Dlatego żaden licznik w komponencie nie jest do tego potrzebny.
 *
 * Myślenie NIE ma pierścieni: `loading` (jedyny stan z pierścieniami na pasku)
 * zapala się wyłącznie przy zimnym starcie dostawcy, bo pierścienie znaczą
 * „nic jeszcze nie działa", a nie „bot myśli".
 */
export function stripMascotState(input: {
  bot: MascotBotProfile;
  runtime?: RuntimePhase | null;
  /** trwa strumień tekstu asystenta (store.streaming[threadId]) */
  streaming?: boolean;
  /** bot jest w żywej wymianie z innym botem (`isEngagedInPeerChat`) */
  engaged?: boolean;
  /** okno aplikacji jest na wierzchu — wtedy „nieprzeczytane" nic nie znaczy */
  focused?: boolean;
  now?: number;
}): BotState | null {
  const { bot, runtime = null, streaming = false, engaged = false, focused = false, now = Date.now() } = input;
  const last = bot.messages?.[bot.messages.length - 1];
  const attention = bot.needsAttention ?? null;

  // 1-2: bot czeka na człowieka.
  if (pendingAsk(last) || attention?.trimEnd().endsWith("?")) return "confused";
  if (attention !== null) return "alerting";
  // Faza `runtime` nigdy się nie kasuje — store wyłącznie nadpisuje wpis
  // kolejnym tickiem — a tura ubita w środku (`runtime.error`, przerwanie,
  // watchdog) nie dosyła już „done". Bez tej bramki OSTATNIA faza zamrożonej
  // tury trzymałaby pasek w nieskończoność: kiedyś na „working", a odkąd
  // skończone narzędzie wraca na `reasoning`, na „thinking". Wszystkie wiersze
  // czytające `runtime` pytają więc najpierw, czy tura w ogóle żyje.
  const live = bot.busy !== false;
  // 3: narzędzie w locie. To samo dotyczy porzuconej aktywności.
  const toolInFlight =
    live && (runtime?.kind === "tool" || (last?.kind === "activity" && last.tool?.ok === undefined));
  if (toolInFlight) return "working";
  // 4: rozumuje albo tura ruszyła i nic jeszcze z niej nie wyszło.
  if (live && (runtime?.kind === "reasoning" || (runtime?.kind === "start" && now - runtime.at < MODEL_LOAD_MS))) {
    return "thinking";
  }
  // 5: tekst leci TERAZ — ciało rozpada się na trzy kropki (stan silnika, nie
  // nakładka). Świeżość jest tu istotna: `streaming` wisi do końca tury, więc
  // bez `WRITING_MS` kropki zostawały na pasku także wtedy, gdy bot dawno
  // przestał pisać i po prostu pracował.
  if (live && streaming && runtime?.kind === "text" && now - runtime.at < WRITING_MS) return "thinking-dots";
  // 5b: tekst był, ale ucichł, a tura wciąż trwa — bot pracuje dalej.
  if (live && runtime?.kind === "text") return "working";
  // 6: dostawca milczy od MODEL_LOAD_MS — zimny start modelu albo procesu.
  if (live && runtime?.kind === "start") return "loading";
  // 7: tura właśnie się skończyła — moment radości, już po `busy`.
  if (runtime?.kind === "done" && now - runtime.at < CELEBRATE_MS) return "celebrate";
  // 8: tura wciąż otwarta, a nic bliższego o niej nie wiadomo — pasek zostaje na
  // „working". To jedyny wiersz, który trzyma maskotkę przez całą turę, gdy
  // dostawca nie sypie eventami; kończy go dopiero `busy:false` z serwera.
  if (bot.busy === true) return "working";
  // 9: bot rozmawia z innym botem, a teraz kolej TAMTEGO — własnej tury nie ma,
  // więc żaden wiersz wyżej nie zapala się i pasek gasł w środku wymiany.
  // Czekanie na odpowiedź kolegi to nadal udział w rozmowie: maskotka nasłuchuje
  // (`listening`) aż do końca wymiany, a potem przechodzi sprężyną w to, co
  // zostanie — bez odmontowania, więc bez przeskoku.
  if (engaged) return "listening";
  if (bot.unread && !focused) return "notifying";
  return null;
}

/**
 * Selects a state from live state first, then from what the bot is about.
 * The keyword groups deliberately overlap as little as possible so a bot's
 * visual identity stays stable while its title and description are edited.
 */
export function stateForBot(bot: MascotBotProfile): BotState {
  const pinned = normalizeState(bot.mascotExpression);
  if (pinned) return pinned;

  const last = bot.messages?.[bot.messages.length - 1];

  if (last?.kind === "activity" && last.tool?.ok === false) return "alerting";
  if (bot.busy) return "working";
  if (bot.unread) return "notifying";
  if (last?.kind === "options") return "curious";

  const profile = `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`.toLowerCase();
  const matches = (words: RegExp) => words.test(profile);

  if (matches(/\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b/)) {
    return "working";
  }
  if (matches(/\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b/)) {
    return "searching";
  }
  if (matches(/\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b/)) {
    return "excited";
  }
  if (matches(/\b(overnight|night|background|async|queue|batch|long-running)\b/)) {
    return "drowsy";
  }
  if (matches(/\b(monitor|monitoring|incident|alert|watch|status|uptime)\b/)) {
    return "radar";
  }
  if (matches(/\b(review|reviewer|audit|critic|critique|quality|qa|test|legal)\b/)) {
    return "suspicious";
  }
  if (matches(/\b(security|secure|compliance|risk|privacy|finance|financial)\b/)) {
    return "scared";
  }
  if (matches(/\b(design|designer|creative|brainstorm|art|illustration|music|story)\b/)) {
    return "playful";
  }
  if (matches(/\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b/)) {
    return "happy";
  }

  return "idle";
}
