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

export const BOT_COLOR_NAMES = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
  // multibot: czarny jest wybieralny, ale nie wchodzi do rotacji nowych botow
  // (serwerowe COLORS) — bot dostaje go tylko wtedy, gdy ktos go ustawi.
  "black",
] as const;

export type BotColor = (typeof BOT_COLOR_NAMES)[number];

export const BOT_COLORS: Record<BotColor, string> = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
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

/**
 * Awatar bota poza paskiem nad composerem: ZAWSZE nieruchomy — neutralny stan
 * "idle", zero beatow, `animated:false` -> `paused` w BlobAvatar. Takze gdy
 * bot pracuje.
 *
 * Jeden animowany bot na cala aplikacje, ten na pasku nad composerem; o jego
 * stanie decyduje `stripMascotState`. Pasek boczny, naglowek czatu, wiersz
 * grupy i karta hovera wolaja ten helper i stoja.
 */
export function sidebarAvatarProps(
  _bot: Bot,
): { state: BotState; motion: BotMotion; animated: boolean; motionKey: number } {
  return { state: "idle", motion: "none", animated: false, motionKey: 0 };
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
 * pytanie > uwaga > narzędzie > myślenie > pisanie > zimny start > sukces >
 * nieprzeczytane. `bot.busy` samo w sobie NIE jest wyzwalaczem — pracujący bot,
 * o którym nic jeszcze nie wiadomo, nie zajmuje paska.
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
  /** okno aplikacji jest na wierzchu — wtedy „nieprzeczytane" nic nie znaczy */
  focused?: boolean;
  now?: number;
}): BotState | null {
  const { bot, runtime = null, streaming = false, focused = false, now = Date.now() } = input;
  const last = bot.messages?.[bot.messages.length - 1];
  const attention = bot.needsAttention ?? null;

  // 1-2: bot czeka na człowieka.
  if (pendingAsk(last) || attention?.trimEnd().endsWith("?")) return "confused";
  if (attention !== null) return "alerting";
  // 3: narzędzie w locie — ale tylko przy żywej turze. Faza `runtime` nigdy się
  // nie kasuje (store wyłącznie nadpisuje wpis kolejnym tickiem), a po turze
  // ubitej w środku narzędzia „done" już nie przyjdzie; bez tej bramki pasek
  // zostałby na „working" na zawsze. To samo dotyczy porzuconej aktywności.
  const toolInFlight =
    bot.busy !== false &&
    (runtime?.kind === "tool" || (last?.kind === "activity" && last.tool?.ok === undefined));
  if (toolInFlight) return "working";
  // 4: rozumuje albo tura ruszyła i nic jeszcze z niej nie wyszło.
  if (runtime?.kind === "reasoning" || (runtime?.kind === "start" && now - runtime.at < MODEL_LOAD_MS)) {
    return "thinking";
  }
  // 5: leci tekst — ciało rozpada się na trzy kropki (stan silnika, nie nakładka).
  if (streaming || runtime?.kind === "text") return "thinking-dots";
  // 6: dostawca milczy od MODEL_LOAD_MS — zimny start modelu albo procesu.
  if (runtime?.kind === "start") return "loading";
  if (runtime?.kind === "done" && now - runtime.at < CELEBRATE_MS) return "celebrate";
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
