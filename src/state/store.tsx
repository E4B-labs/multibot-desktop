// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { MascotShape } from "@/lib/mascotShapes";
import type { MausColor, MausMotion, RuntimeKind, RuntimePhase } from "@/lib/mascot";
import { MAUS_COLORS } from "@/lib/mascot";
import { authFetch, authenticatedEventSource, ensureBrowserSession, getAuthMode } from "@/lib/auth";
import { getLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import {
  botNotificationIcon,
  notify,
  notifyFrame,
  readDesktopNotifications,
  shouldNotify,
  shouldNotifyRoomDone,
  type NotifySnapshot,
} from "@/lib/notifications";
import { sortMessages } from "@/lib/messageOrder";
import type { AutoVerifySettings } from "@/lib/autoVerifyTypes";

export type { MausColor } from "@/lib/mascot";

const SELECTED_BOT_KEY = "multibot.selectedBot";
// multibot: klient trzyma ostatnie pokoje współpracy dla wskaźnika aktywności;
// pełne transkrypty serwer trzyma na dysku, ten sufit ogranicza tylko pamięć UI.
const MAX_KNOWN_ROOMS = 40;

/** Zamknięty zbiór konektorów kart `connect` — mirror server/store.ts. */
export type ConnectorTarget = "composio" | "google-workspace" | "mcp" | "computer";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** multibot: `computer-handoff` — bot prosi człowieka o zrobienie czegoś na
   *  jego komputerze (logowanie, 2FA, captcha). `connect` — bot prosi o
   *  podłączenie konektora i NIE czeka. Brak = zwykła karta. */
  kind?: "computer-handoff" | "connect";
  /** karty `connect`: konektor, który otwiera przycisk „Podłącz". */
  connector?: ConnectorTarget;
}

/** Skill widziany przez czat: nazwa do podświetlenia + opis do popovera. */
export interface SkillRefInfo {
  name: string;
  description?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "event" | "screen" | "room" | "secret";
  text?: string;
  card?: OptionCardData;
  secret?: { target: string; label: string; description: string; placeholder?: string; helpUrl?: string; requestKey: string; provided?: boolean; dismissed?: boolean };
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  event?: { type: "renamed" | "skill-created" | "routine-created" | "reminder-created" | "goal-progress"; value: string };
  /** collaboration-room chip: "X texted Y" / "X replied" → opens the read-only room */
  room?: { id: string; name: string; bot_ids: string[]; ownerBotId: string; status: string; event?: "texted" | "replied"; groupId?: string };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  attachments?: Array<{ id: string; name: string; mime: string; size: number }>;
  /** multibot (F12): model, który obsłużył tę wiadomość — badge w UI */
  model?: string;
  /** multibot: flat reply — id wiadomości, na którą odpowiada ta wiadomość. */
  replyToId?: string;
  userId?: string;
  userName?: string;
  order?: number;
  /** optimistic echo — user message waiting for the server's confirmation */
  pending?: boolean;
  at: number;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
}

export interface Bot {
  id: string;
  threadId: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  mascotShape?: MascotShape;
  avatarUrl?: string | null;
  visibility?: "public" | "team" | "private";
  ownerId?: string;
  allowedUserIds?: string[];
  unread: boolean;
  /** multibot: id pierwszej nieprzeczytanej wiadomości — nad nią rysujemy
   *  separator "NEW" (wyczyszczany przy otwarciu czatu / select). */
  firstUnreadId?: string | null;
  /** multibot: sekcja sidebaru (port z OpenMausBot #296) — brak = lista główna. */
  section?: string;
  chiefOfStaff?: boolean;
  composioAccounts?: Record<string, string>;
  busy?: boolean;
  // multibot: why the bot is waiting on a human (login/captcha/question); null/absent = not waiting.
  // Arrives via the same `{kind:"bot"}` SSE frame as every other bot patch.
  needsAttention?: string | null;
  modelSelection: ModelSelection;
  /** multibot: „Fast mode" — szybciej zamiast głębiej (dziś czyta go driver codex). */
  fastMode?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  messages: Message[];
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  opencode?: { configured: boolean };
  composio: { configured: boolean; apiKeyConfigured?: boolean };
  box: { configured: boolean };
  /** harness text-to-speech key — SpeakButton speaks through the harness when it
   *  is set, and through the engine's edge-tts when it is not */
  voice?: { configured: boolean };
  /** strefa czasowa bota; pusty ciąg albo brak = wykryj z systemu */
  timeZone?: string;
  /** Autoweryfikacja: czy sprawdzać akcje i jakie reguły je przepuszczają */
  autoVerify?: AutoVerifySettings;
  /** kolejność sekcji sidebaru — wspólna dla desktopu i telefonu */
  sectionOrder?: string[];
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  models: { default: string; options: Array<{ id: string; label: string }>; updatedAt?: string };
}

// multibot: F9-FE — grupa harnessu: {id, name, bot_ids}. Obiekt siedzi w stanie,
// bo GroupPanel potrzebuje nazwy i składu, a listę grup trzyma Sidebar lokalnie
// — store zna tylko otwartą.
export interface EngineGroup {
  id: string;
  name: string;
  bot_ids: string[];
  /** sekcja sidebaru — grupa siedzi w sekcji tak samo jak bot */
  section?: string;
  messages?: Array<{ id: string; from: "you" | string; text: string; at: number }>;
}

/** Durable bot-to-bot collaboration room (read-only for the user). */
export interface Room {
  id: string;
  name: string;
  task: string;
  /** Participating bots, originator first; three or more is normal. */
  bot_ids: string[];
  createdAt: number;
  /** Bot that opened the room and gets the closing report. */
  ownerBotId: string;
  transcript: Array<{ id: string; from: string; text: string; at: number }>;
  status: "running" | "done" | "failed";
  activeBotId?: string | null;
  /** Group chat this room mirrors, when it is a group conversation. */
  groupId?: string;
}

export interface FleetEnvironmentBot {
  id: string;
  name: string;
  title?: string;
  description?: string;
  model?: string;
  state: "idle" | "working" | "waiting";
}

export interface FleetEnvironment {
  revision?: number;
  refreshedAt: number;
  refreshIntervalMs: number;
  bots: FleetEnvironmentBot[];
}

interface AppState {
  bots: Bot[];
  environment: FleetEnvironment | null;
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  selectedId: string;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  /** multibot: konektor, o który poprosił bot kartą „Podłącz" — panel wtyczek
   *  otwiera się od razu na właściwej zakładce. */
  pluginsConnector?: ConnectorTarget;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  // multibot: F6 — panel rutyn, ten sam prawy slot co settings/computer
  routinesOpen: boolean;
  // multibot: F8 — panele pamięci i skilli, ten sam prawy slot
  memoryOpen: boolean;
  skillsOpen: boolean;
  // multibot: live team map (port z OpenMausBot)
  teamMapOpen: boolean;
  inspectorOpen: boolean;
  /** multibot: skille bieżącego bota — nazwy podświetlają się w treści
   *  wiadomości (skillRefs), a opis wchodzi do popovera nad taką nazwą. */
  skills: SkillRefInfo[];
  /** multibot: skill, na którym panel skilli ma się otworzyć rozwinięty. */
  skillFocus: string | null;
  // multibot: F9-FE — otwarty pokój grupowy (prawy slot); null = zamknięty
  groupOpen: EngineGroup | null;
  // multibot: otwarty read-only pokój współpracy botów (zastępuje widok czatu)
  roomOpen: Room | null;
  /** "Bot rooms" list view — every bot-to-bot conversation in one place. */
  roomsOpen: boolean;
  /** multibot: znane pokoje współpracy (ostatnie N) — z nich wskaźnik
   *  „boty rozmawiają między sobą" wybiera aktywnego partnera dla czatu. */
  rooms: Room[];
  /** in-flight assistant text per threadId (content.delta fold) */
  streaming: Record<string, string>;
  /** multibot: faza tury per threadId — serwer rozróżnia rozumowanie od
   *  wyjścia (contracts `streamKind`), a pasek nad composerem rysuje z tego
   *  „myśli" vs „pisze". Bez timerów sprzątających: wpis wygasa sam, bo
   *  `stripMascotState` porównuje `at` z zegarem. */
  runtime: Record<string, RuntimePhase>;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  connected: boolean;
  workspaceVersion: number;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
}

type Action =
  | { type: "hydrate"; bots: Bot[] }
  | { type: "environment"; environment: FleetEnvironment }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "selectComputer"; id: string }
  | { type: "send"; botId: string; text: string; reasoning?: string; attachmentIds?: string[]; replyToId?: string }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "dismissCard"; botId: string; messageId: string }
  | { type: "newBot"; visibility?: "team" | "private" }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: Partial<Bot> & { id: string } }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "streamDelta"; threadId: string; delta: string }
  | { type: "runtimeTick"; threadId: string; kind: RuntimeKind }
  | { type: "streamClear"; threadId: string }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "workspaceChanged"; botId: string; resource: string }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean; connector?: ConnectorTarget }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleAppSettings"; open?: boolean }
  // multibot: F6 — otwarcie/zamknięcie panelu rutyn
  | { type: "toggleRoutines"; open?: boolean }
  // multibot: F8 — otwarcie/zamknięcie paneli pamięci i skilli
  | { type: "toggleMemory"; open?: boolean }
  | { type: "toggleSkills"; open?: boolean; skill?: string }
  // multibot: team map (port z OpenMausBot)
  | { type: "toggleTeamMap"; open?: boolean }
  | { type: "toggleInspector"; open?: boolean }
  /** multibot: nazwy skilli do podświetlania w treści wiadomości */
  | { type: "setSkills"; skills: SkillRefInfo[] }
  // multibot: F9-FE — otwarcie pokoju grupowego (group) / zamknięcie (null)
  | { type: "toggleGroup"; group: EngineGroup | null }
  // multibot: otwarcie read-only pokoju współpracy / zamknięcie (null)
  | { type: "toggleRoom"; room: Room | null }
  | { type: "toggleRooms"; open?: boolean }
  /** multibot: pełna lista pokoi z GET /api/rooms (hydratacja po starcie) */
  | { type: "roomsSet"; rooms: Room[] }
  /** multibot: jeden pokój z kanału {kind:"room"} — wstaw lub odśwież */
  | { type: "roomUpsert"; room: Room }
  | {
      type: "updateBot";
      botId: string;
      patch: Partial<
        Pick<
          Bot,
          "name" | "title" | "description" | "notifications" | "color" | "mascotExpression" | "mascotShape" | "avatarUrl" | "pinned" | "hidden" | "chiefOfStaff" | "composioAccounts" | "fastMode"
        >
        // multibot: sekcja dopuszcza null — JSON.stringify wycina undefined,
        // a null musi dolecieć do serwera, żeby wyczyścić pole.
      > & { section?: string | null };
    };

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const saved =
        typeof window !== "undefined" ? window.localStorage.getItem(SELECTED_BOT_KEY) : null;
      const selectedId = saved && action.bots.some((b) => b.id === saved)
        ? saved
        : action.bots.some((b) => b.id === state.selectedId) && state.selectedId
          ? state.selectedId
          : (action.bots[0]?.id ?? "");
      // multibot: bot oznaczony przez serwer jako nieprzeczytany, a nie jest
      // właśnie otwarty → zapamiętaj pierwszą nieprzeczytaną wiadomość (ost. wpis)
      const bots = action.bots.map((b) => {
        const messages = sortMessages(b.messages);
        return {
          ...b,
          messages,
          firstUnreadId:
            b.unread && b.id !== selectedId ? (messages.at(-1)?.id ?? null) : b.firstUnreadId,
        };
      });
      return { ...state, bots, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "environment":
      if ((action.environment.revision ?? 0) < (state.environment?.revision ?? -1)) return state;
      return { ...state, environment: action.environment };
    case "workspaceChanged":
      return { ...state, workspaceVersion: state.workspaceVersion + 1 };
    case "configStatus":
      return { ...state, config: { ...state.config, ...action.config, profile: action.config.profile ?? state.config?.profile } };
    // multibot: selecting a bot leaves group conversation mode.
    case "select": {
      // Otwierany bot: czyść unread, ale ZOSTAW firstUnreadId — separator "NEW"
      // ma być widoczny właśnie po otwarciu czatu (pokazuje granicę nowych).
      const entered = updateBot(
        withMascotMotion({ ...state, selectedId: action.id, groupOpen: null, roomOpen: null, roomsOpen: false }, action.id, "switch"),
        action.id,
        (b) => ({ ...b, unread: false }),
      );
      const leavingId = state.selectedId;
      if (!leavingId || leavingId === action.id) return entered;
      // Odchodzimy od innego bota → kasujemy jego marker (już go przejrzałeś).
      return updateBot(entered, leavingId, (b) => ({ ...b, firstUnreadId: null }));
    }
    case "selectComputer":
      return { ...state, selectedId: action.id };
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard":
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, { answered: action.answer, dismissed: true }),
        action.botId,
        "working",
      );
    case "dismissCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "botAdded":
      return withMascotMotion({
        ...state,
        bots: [action.bot, ...state.bots],
        selectedId: action.bot.id,
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bots, selectedId };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({
        ...b,
        unread: true,
        firstUnreadId: b.messages[b.messages.length - 1]?.id ?? null,
      }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      const becameUnread = Boolean(action.bot.unread) && !before?.unread;
      const kind =
        becameUnread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const next = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      // multibot: przejście read→unread zaczyna separatorek "NEW" nad pierwszą
      // nową wiadomością; `...action.bot` (bez firstUnreadId) nie nadpisuje go
      return updateBot(next, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        messages: b.messages,
        firstUnreadId: becameUnread ? (b.messages[b.messages.length - 1]?.id ?? null) : b.firstUnreadId,
      }));
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      // a confirmed user message replaces the optimistic echo, not duplicates it
      const withoutPending =
        action.message.role === "user"
          ? (msgs: Message[]) => msgs.filter((m) => !(m.role === "user" && m.pending))
          : (msgs: Message[]) => msgs;
      // multibot: jak czytasz bota na żywo (jest otwarty), granica "NEW" jest
      // nieaktualna — kasujemy ją przy każdej nowej wiadomości na tym wątku.
      // Gdy bot jest nieprzeczytany i nieotwarty, pierwsza taka wiadomość
      // stawia granicę (odporne na kolejność SSE message vs bot.unread).
      const viewing = bot.id === state.selectedId;
      const next = updateBot(state, bot.id, (b) => {
        const msgs = withoutPending(b.messages);
        const messages = sortMessages(
          msgs.some((m) => m.id === action.message.id) ? msgs : [...msgs, action.message],
        );
        const firstUnreadId = viewing
          ? null
          : (b.unread && !b.firstUnreadId ? action.message.id : b.firstUnreadId);
        return { ...b, messages, firstUnreadId };
      });
      const motion =
        action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      // a settled assistant bubble replaces the in-flight stream
      if (action.message.role === "bot" && action.message.kind === "text") {
        const { [action.threadId]: _, ...rest } = animated.streaming;
        return { ...animated, streaming: rest };
      }
      return animated;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: sortMessages(b.messages.map((m) => (m.id === action.message.id ? action.message : m))),
      }));
    }
    case "runtimeTick":
      return {
        ...state,
        runtime: { ...state.runtime, [action.threadId]: { at: Date.now(), kind: action.kind } },
      };
    case "streamDelta":
      return {
        ...state,
        streaming: {
          ...state.streaming,
          [action.threadId]: (state.streaming[action.threadId] ?? "") + action.delta,
        },
      };
    case "streamClear": {
      const { [action.threadId]: _, ...rest } = state.streaming;
      return { ...state, streaming: rest };
    }
    case "screenFrame":
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    // bot settings, the computer panel, app settings, and routines share the right slot
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        groupOpen: open ? null : state.groupOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    case "togglePlugins":
      return {
        ...state,
        pluginsOpen: action.open ?? !state.pluginsOpen,
        pluginsConnector: action.connector,
        roomsOpen: action.open ? false : state.roomsOpen,
      };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        groupOpen: open ? null : state.groupOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    // multibot: F6 — panel rutyn wypycha pozostałych lokatorów prawego slotu
    case "toggleRoutines": {
      const open = action.open ?? !state.routinesOpen;
      return {
        ...state,
        routinesOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        groupOpen: open ? null : state.groupOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    // multibot: F8 — panele pamięci i skilli, ta sama zasada wzajemnego wykluczania
    case "toggleMemory": {
      const open = action.open ?? !state.memoryOpen;
      return {
        ...state,
        memoryOpen: open,
        skillsOpen: open ? false : state.skillsOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        groupOpen: open ? null : state.groupOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    case "toggleSkills": {
      const open = action.open ?? !state.skillsOpen;
      return {
        ...state,
        skillsOpen: open,
        skillFocus: open ? action.skill ?? null : null,
        memoryOpen: open ? false : state.memoryOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        groupOpen: open ? null : state.groupOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    // multibot: team map — globalny overlay niezależny od prawego slotu
    case "toggleTeamMap":
      return { ...state, teamMapOpen: action.open ?? !state.teamMapOpen };
    case "toggleInspector": {
      const open = action.open ?? !state.inspectorOpen;
      return {
        ...state,
        inspectorOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    case "setSkills":
      return { ...state, skills: action.skills };
    // multibot: F9-FE — pokój grupowy w prawym slocie, ta sama zasada wykluczania
    case "toggleGroup": {
      const open = action.group !== null;
      return {
        ...state,
        groupOpen: action.group,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    // multibot: read-only bot collaboration room replaces the chat view.
    case "toggleRoom": {
      const open = action.room !== null;
      return {
        ...state,
        roomOpen: action.room,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        roomsOpen: open ? false : state.roomsOpen,
      };
    }
    // multibot: hydratacja listy pokoi — klient trzyma ostatnie N do wskaźnika,
    // ale pełne transkrypty pozostają dostępne z wiadomości pokoju.
    case "roomsSet":
      return {
        ...state,
        rooms: action.rooms.slice(-MAX_KNOWN_ROOMS),
      };
    case "roomUpsert": {
      const others = state.rooms.filter((room) => room.id !== action.room.id);
      return {
        ...state,
        rooms: [...others, action.room].slice(-MAX_KNOWN_ROOMS),
      };
    }
    case "toggleRooms": {
      const open = action.open ?? !state.roomsOpen;
      return {
        ...state,
        roomsOpen: open,
        roomOpen: open ? null : state.roomOpen,
        groupOpen: open ? null : state.groupOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotShape") ||
        Object.prototype.hasOwnProperty.call(action.patch, "avatarUrl");
      const next = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      return updateBot(next, action.botId, (b) => {
        // multibot: section null = wyczyszczona (zgodnie z PATCH-em serwera)
        const { section, ...rest } = action.patch;
        const merged = { ...b, ...rest };
        if (section !== undefined) merged.section = section ?? undefined;
        return merged;
      });
    }
    // handled entirely by the async wrapper — but the user's message must
    // appear instantly, not after the server round-trip (SSE messageAdded)
    case "send": {
      const bot = state.bots.find((b) => b.id === action.botId);
      const echo: Message = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "user",
        kind: "text",
        text: action.text,
        ...(action.replyToId ? { replyToId: action.replyToId } : {}),
        at: Date.now(),
        pending: true,
      };
      return bot
        ? updateBot(withMascotMotion(state, action.botId, "working"), bot.id, (b) => ({
            ...b,
            messages: [...b.messages, echo],
          }))
        : withMascotMotion(state, action.botId, "working");
    }
    case "newBot":
    case "duplicateBot":
    case "interrupt":
      return state;
  }
}

const initialState: AppState = {
  bots: [],
  environment: null,
  instances: [],
  config: null,
  selectedId: "",
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  routinesOpen: false,
  memoryOpen: false,
  skillsOpen: false,
  teamMapOpen: false,
  inspectorOpen: false,
  skills: [],
  skillFocus: null,
  groupOpen: null,
  roomOpen: null,
  roomsOpen: false,
  rooms: [],
  streaming: {},
  runtime: {},
  screens: {},
  provisioning: {},
  connected: false,
  workspaceVersion: 0,
  error: null,
  mascotMotion: null,
};

// ── API client ─────────────────────────────────────────────────────────
export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const notificationState = useRef(new Map<string, NotifySnapshot>());
  const roomNotificationState = useRef(new Map<string, string>());

  useEffect(() => {
    if (state.selectedId) window.localStorage.setItem(SELECTED_BOT_KEY, state.selectedId);
  }, [state.selectedId]);

  // multibot: powiadomienia systemowe. Regułę „czy w ogóle" trzyma
  // shouldNotify (czysta, testowalna); tu zostaje treść banerki i wysyłka —
  // pod Electronem przez most do procesu głównego, w przeglądarce zwykłym API.
  useEffect(() => {
    const seen = notificationState.current;
    const lang = getLanguage();
    const ctx = {
      focused: typeof document === "undefined" || document.hasFocus(),
      selectedBotId: state.selectedId,
      enabled: readDesktopNotifications(),
    };
    for (const bot of state.bots) {
      const before = seen.get(bot.id);
      const next: NotifySnapshot = {
        id: bot.id,
        busy: bot.busy,
        unread: bot.unread,
        needsAttention: bot.needsAttention ?? null,
        notifications: bot.notifications,
      };
      seen.set(bot.id, next);
      const reason = shouldNotify(before, next, ctx);
      if (!reason) continue;
      const last = [...bot.messages].reverse().find((message) => message.role === "bot" && message.text);
      notify({
        title: `${botDisplayName(bot, lang)} ${reason === "attention" ? "needs your input" : "finished"}`,
        body: reason === "attention" ? (next.needsAttention ?? "") : last?.text?.slice(0, 180) ?? "New bot message",
        botId: bot.id,
        icon: botNotificationIcon(MAUS_COLORS[bot.color]),
      });
    }
  }, [state.bots, state.selectedId]);

  // Pokój współpracy zamknął temat — nikt na niego nie patrzy godzinami.
  useEffect(() => {
    const seen = roomNotificationState.current;
    const enabled = readDesktopNotifications();
    const focused = typeof document === "undefined" || document.hasFocus();
    for (const room of state.rooms) {
      const before = seen.get(room.id);
      seen.set(room.id, room.status);
      const viewing = focused && state.roomOpen?.id === room.id;
      if (shouldNotifyRoomDone(before, room.status, { enabled, viewing })) {
        notify({ title: `${room.name} finished`, body: String(room.task ?? "").slice(0, 180) });
      }
    }
  }, [state.rooms, state.roomOpen]);

  // debounced PATCH per bot for text-field edits (name/title/description)
  const patchTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, unknown> }>());

  const dispatch = useMemo(() => {
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    // fire-and-forget card persistence; the route is optional server-side
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      authFetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      rawDispatch(action);
      switch (action.type) {
        case "send":
          api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({
              text: action.text,
              ...(action.reasoning ? { reasoning: action.reasoning } : {}),
              ...(action.attachmentIds?.length ? { attachmentIds: action.attachmentIds } : {}),
              ...(action.replyToId ? { replyToId: action.replyToId } : {}),
            }),
          }).catch(showError);
          break;
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
            const behavior =
              action.answer === "Allow" ? "allow"
                : action.answer === "Allow for all" ? "always"
                  : action.answer === "Deny" ? "deny"
                    : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
              }),
            }).catch(showError);
          } else {
            persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          api("/api/bots", { method: "POST", body: JSON.stringify({ visibility: action.visibility ?? "team" }) })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: `${source.name} copy`,
                  title: source.title,
                  description: source.description,
                  notifications: source.notifications,
                  modelSelection: source.modelSelection,
                }),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          api(`/api/bots/${action.botId}`, { method: "DELETE" }).catch(showError);
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          }
          // multibot (A2): otwarcie bota rozgrzewa jego proces CLI, żeby pierwsza
          // wiadomość nie płaciła zimnego startu. Fire-and-forget — błąd niczego
          // tu nie zmienia, bo tura i tak postawi proces sama, tylko wolniej.
          api(`/api/bots/${action.id}/warm`, { method: "POST" }).catch(() => {});
          break;
        }
        case "setModel":
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection }),
          }).catch(showError);
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "updateBot": {
          const timers = patchTimers.current;
          const pending = timers.get(action.botId);
          const patch = { ...pending?.patch, ...action.patch };
          if (pending) clearTimeout(pending.timer);
          timers.set(action.botId, {
            patch,
            timer: setTimeout(() => {
              timers.delete(action.botId);
              api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify(patch) }).catch(showError);
            }, 400),
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, []);

  // Kliknięcie w banerkę: proces główny podniósł już okno, interfejsowi
  // zostaje otworzyć tego bota. Nieobecne poza Electronem.
  useEffect(
    () =>
      window.ogb?.onNotificationClick?.((botId) => {
        if (!stateRef.current.bots.some((bot) => bot.id === botId)) return;
        dispatch({ type: "toggleAppSettings", open: false });
        dispatch({ type: "select", id: botId });
      }),
    [dispatch],
  );

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const loadAll = () => {
      api("/api/bots")
        .then(({ bots }) => alive && rawDispatch({ type: "hydrate", bots }))
        .catch(() => {});
      api("/api/environment")
        .then(({ environment }) => alive && environment && rawDispatch({ type: "environment", environment }))
        .catch(() => {});
      api("/api/instances")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
      api("/api/config")
        .then((config) => alive && rawDispatch({ type: "configStatus", config }))
        .catch(() => {});
      // multibot: znane pokoje współpracy — bez tego wskaźnik rozmów botów
      // zobaczyłby aktywność dopiero po pierwszej ramce SSE, nie po odświeżeniu.
      api("/api/rooms")
        .then(({ rooms }) => alive && rawDispatch({ type: "roomsSet", rooms: Array.isArray(rooms) ? rooms : [] }))
        .catch(() => {});
    };
    const sessionReady = getAuthMode() === "v2" ? ensureBrowserSession() : Promise.resolve();
    void sessionReady.finally(loadAll);
    const catalogTimer = window.setInterval(() => {
      api("/api/instances")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
    }, 12 * 60 * 60 * 1000);

    let lastSequence = 0;
    const es = authenticatedEventSource(`/api/events?lang=${getLanguage()}`);
    es.onopen = () => {
      rawDispatch({ type: "connected", value: true });
      loadAll(); // resync anything missed while disconnected
    };
    es.onerror = () => rawDispatch({ type: "connected", value: false });
    es.onmessage = (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (Number.isSafeInteger(frame.sequence) && frame.sequence > 0) {
        if (frame.sequence <= lastSequence) return;
        lastSequence = frame.sequence;
      }
      switch (frame.kind) {
        case "environment.snapshot":
          if (frame.environment) rawDispatch({ type: "environment", environment: frame.environment });
          break;
        case "message":
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          break;
        case "workspace":
          rawDispatch({ type: "workspaceChanged", botId: frame.botId, resource: frame.resource });
          break;
        // multibot: bot poprosił o banerkę wprost (przypomnienie, notify_user)
        case "notify": {
          const payload = notifyFrame(frame, { enabled: readDesktopNotifications() });
          if (payload) {
            const bot = stateRef.current.bots.find((b) => b.id === payload.botId);
            notify({ ...payload, icon: bot ? botNotificationIcon(MAUS_COLORS[bot.color]) : undefined });
          }
          break;
        }
        case "group":
          rawDispatch({ type: "workspaceChanged", botId: "", resource: "groups" });
          break;
        case "room": {
          // live transcript of the open collaboration room
          const room = frame.room as Room | undefined;
          if (!room) break;
          // multibot: każdy pokój ląduje w stanie (nie tylko otwarty) — z tej
          // listy wskaźnik „boty rozmawiają między sobą" wybiera partnera.
          rawDispatch({ type: "roomUpsert", room });
          const open = stateRef.current.roomOpen;
          if (open?.id === room.id) rawDispatch({ type: "toggleRoom", room });
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "bot": {
          const bot = frame.bot as Partial<Bot> & { id: string };
          // reading the selected chat clears its badge immediately
          if (bot.unread && bot.id === stateRef.current.selectedId) {
            bot.unread = false;
            authFetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "botPatched", bot });
          break;
        }
        case "runtime": {
          const event = frame.event;
          // multibot: pasek nad composerem odróżnia „myśli" od „pisze", więc
          // reasoning nie jest już wyrzucany — obie ścieżki zapisują fazę tury.
          if (event.type === "turn.started") {
            rawDispatch({ type: "runtimeTick", threadId: event.threadId, kind: "start" });
          } else if (event.type === "item.started" && event.itemType === "reasoning") {
            rawDispatch({ type: "runtimeTick", threadId: event.threadId, kind: "reasoning" });
          } else if (event.type === "item.started" && event.itemType === "tool") {
            // multibot: bot odpala narzędzie — pasek pokazuje „working" (bez
            // pierścieni). Pierścienie zostają wyłącznie na zimny start.
            rawDispatch({ type: "runtimeTick", threadId: event.threadId, kind: "tool" });
          } else if (event.type === "content.delta" && event.streamKind === "reasoning_text") {
            rawDispatch({ type: "runtimeTick", threadId: event.threadId, kind: "reasoning" });
          } else if (event.type === "content.delta" && event.streamKind === "assistant_text") {
            rawDispatch({ type: "runtimeTick", threadId: event.threadId, kind: "text" });
            rawDispatch({ type: "streamDelta", threadId: event.threadId, delta: event.delta });
          } else if (event.type === "turn.completed") {
            rawDispatch({ type: "runtimeTick", threadId: event.threadId, kind: "done" });
            rawDispatch({ type: "streamClear", threadId: event.threadId });
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "bot.deleted":
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: { xai: frame.xai, opencode: frame.opencode, composio: frame.composio, box: frame.box, profile: frame.profile },
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    return () => {
      alive = false;
      window.clearInterval(catalogTimer);
      es.close();
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  const d = new Date(at);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return getLanguage() === "pl" ? "Wczoraj" : "Yesterday";
  }
  // starsze niż wczoraj — krótka data (bez roku), jak w komunikatorach
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}
