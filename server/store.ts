// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId, type AttachmentMeta, type ModelSelection, type ThreadId } from "./contracts.ts";

export type MausColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral"
  | "black";

/**
 * The face a bot rests on, as one of the engine's state names. Kept as a plain
 * string rather than a union: bots saved under the app's earlier ten-face
 * vocabulary still carry those names, and the client resolves both on read.
 */
export type MausExpression = string;
export type MascotShape = string;

/** Konektory, o które bot może poprosić kartą — zamknięty zbiór, bo każdy
 * prowadzi w konkretne miejsce w interfejsie. */
export type ConnectorTarget = "composio" | "google-workspace" | "mcp" | "computer";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** multibot: rodzaj karty. Brak = zwykła karta pytania/zgody (jak dotąd).
   *  `computer-handoff` — bot oddaje komputer człowiekowi (logowanie, 2FA,
   *  captcha) i czeka: przejmij / gotowe / pomiń.
   *  `connect` — bot potrzebuje konektora, którego nie ma: karta nie blokuje
   *  tury, człowiek podłącza go wtedy, kiedy chce. */
  kind?: "computer-handoff" | "connect";
  /** karty `connect`: który konektor otworzyć w panelu wtyczek. */
  connector?: ConnectorTarget;
}

export interface SecretRequestCardData {
  target: string;
  label: string;
  description: string;
  placeholder?: string;
  helpUrl?: string;
  requestKey: string;
  provided?: boolean;
  dismissed?: boolean;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "event" | "screen" | "room" | "secret";
  text?: string;
  card?: OptionCardData;
  secret?: SecretRequestCardData;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  /** Small durable workspace event shown as a chat pill. */
  event?: { type: "renamed" | "skill-created" | "routine-created" | "reminder-created" | "goal-progress"; value: string };
  /** collaboration-room chip: a clickable "X texted Y" / "X replied" pill
   * leading to the room. `event` names what just happened; without it the pill
   * describes the room as a whole. */
  room?: { id: string; name: string; bot_ids: string[]; ownerBotId: string; status: string; event?: "texted" | "received" | "replied"; groupId?: string };
  /** In the thread for the MODEL, never for the user: peer envelopes and the
   * answers a bot writes to a colleague. The transcript replay (API drivers
   * every turn, CLI drivers after a lost session) walks the thread, so a
   * bot↔bot exchange has to live here or the bot forgets it happened; the
   * chat, the bot list and search all skip it and show a room chip instead. */
  hidden?: boolean;
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  attachments?: AttachmentMeta[];
  /** multibot (F12): model, który obsłużył tę wiadomość — badge w UI. */
  model?: string;
  /** multibot: flat reply — id wiadomości, na którą odpowiada ta wiadomość.
   * Addytywne i opcjonalne; stare zapisy czytają się bez migracji. */
  replyToId?: string;
  /** Authenticated human author; absent on legacy/system messages. */
  userId?: string;
  userName?: string;
  /** Per-thread insertion order; keeps same-millisecond messages identical on every client. */
  order?: number;
  at: number;
}

export interface BotRecord {
  id: string;
  threadId: ThreadId;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: MausExpression | null;
  /** Optional silhouette from the built-in mascot icon set. */
  mascotShape?: MascotShape;
  /** Custom avatar photo (data URL or /api/bots/:id/avatar URL). Circular crop. */
  avatarUrl?: string | null;
  /** Team visibility. Missing legacy values behave as team-visible. */
  visibility?: "public" | "team" | "private";
  /** Firebase UID of creator; legacy bots have no owner and stay team-visible. */
  ownerId?: string;
  /** Firebase UIDs allowed to open a private bot. */
  allowedUserIds?: string[];
  unread: boolean;
  /** multibot: sekcja sidebaru — pusta/nieobecna = lista główna. */
  section?: string;
  /** One optional chief per section. */
  chiefOfStaff?: boolean;
  /** Per-bot Composio account selection, keyed by toolkit slug. */
  composioAccounts?: Record<string, string>;
  modelSelection: ModelSelection;
  /** multibot: „Fast mode" — bot woli szybszą odpowiedź od głębszej. Brak/false
   *  = zachowanie dotychczasowe, więc stare bots.json czyta się bez migracji.
   *  Znaczenie zależy od drivera; dziś czyta je tylko codex. */
  fastMode?: boolean;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** multibot (H1): NIE MA wyboru źródła komputera. Każdy bot ma jeden własny
   * hosted computer (server/hosted-computer.ts) od utworzenia do usunięcia.
   *
   * To pole zostaje WYŁĄCZNIE po to, żeby stary config.json się wczytał —
   * nic go nie odczytuje. Stare wartości ("cloud"/"local"/"playwright"/
   * "shared"/"off") są ignorowane, a bot dostaje hosted computer tak samo jak
   * bot bez tego pola. Nie ma stanu użytkowego "off": awaria to `error` w
   * `ComputerStatus`, nigdy cicha zmiana ustawienia bota.
   * @deprecated legacy, do skasowania gdy żaden config w obiegu go nie ma */
  computer?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** Podagent tymczasowy znika po restarcie serwera. */
  temporary?: boolean;
  busy?: boolean;
  /** multibot (D7): bot silnika czeka na człowieka (login, captcha, pytanie) —
   * treść powodu prosto z eventu `attention`, `null`/brak = nie czeka. Jedzie
   * w bots.json, więc powód przeżywa restart tak samo jak po stronie silnika. */
  needsAttention?: string | null;
  /** multibot (F12): jednorazowy override modelu dla NASTĘPNEJ tury — ustawia
   * `/model --once X` albo sama fraza "użyj modelu X" bez zadania; konsumowany
   * i czyszczony przy najbliższej wiadomości. Nie zmienia `modelSelection`. */
  pendingModelOverride?: string | null;
  /** multibot: bot stworzony przez innego bota — kto i po co go powołał.
   *  Opcjonalne, więc stare zapisy czytają się bez migracji; brak = bot od usera. */
  createdByBotId?: string | null;
  /** multibot: intencja twórcy — np. "Stworzony przez bota X do zadania Y".
   *  To jest kontekst wstrzykiwany do system prompt nowego bota. */
  creationContext?: string | null;
  createdAt: number;
}

export interface SelectionTarget {
  instanceId: string;
  driverKind: string;
  models: { default: string };
  snapshot: { state: "available" | "unavailable" };
}

/** Which provider a bot lands on when nobody picked one (new bot, or a
 * selection whose instance disappeared).
 *
 * Only claude and codex count as that first choice. "Available" means the
 * driver loaded, not that it can answer: the key-based instances (opencode,
 * grok) report available with no key configured and would fail on turn one, so
 * they queue behind the CLI drivers rather than in front of them. */
export function defaultSelectionTarget<T extends SelectionTarget>(targets: readonly T[]): T | undefined {
  const cli = (list: readonly T[]) =>
    list.find((t) => t.driverKind === "claudeAgent") ?? list.find((t) => t.driverKind === "codex");
  const live = targets.filter((t) => t.snapshot.state === "available");
  return cli(live) ?? live[0] ?? cli(targets) ?? targets[0];
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

/** Canonical order shared by persisted history and every UI transport. */
export function sortMessages<T extends { id: string; at: number; order?: number }>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => a.at - b.at || (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
}

/** Rotacja kolorow dla nowych botow — czarnego celowo nie ma, dostaje go
 *  tylko bot, ktoremu ktos go ustawi. */
const COLORS: MausColor[] = [
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
];

/** Kazdy kolor, na ktory wolno ustawic bota. Jedno zrodlo prawdy dla
 *  `managedBotPatch` (bot zmienia bota) i dla PATCH /api/bots/:id (UI). */
export const BOT_COLORS: MausColor[] = [...COLORS, "black"];

/** Kazdy ksztalt maskotki, na ktory wolno ustawic bota. Jedno zrodlo prawdy dla
 *  `managedBotPatch` (bot zmienia bota), PATCH /api/bots/:id (UI) i schematu
 *  narzedzi w `server/drivers/agents-proxy.ts` (bot tworzy bota). Kolejnosc i
 *  zawartosc musza sie zgadzac z MASCOT_SHAPES + LEGACY_SHAPES w
 *  `src/lib/mascotShapes.ts` — pilnuje tego test w `server/store.test.ts`. */
export const BOT_SHAPES: MascotShape[] = [
  "blob", "leaf", "cursor", "circle", "square", "pill", "triangle", "star", "diamond", "folder",
  // Legacy shapes stay editable for bots that already use them.
  "oval", "hexagon", "cloud", "drop",
];

/** Safe profile fields one bot may set on another. Infrastructure, ownership,
 * permissions, thread ids and persisted runtime state never cross this boundary. */
export function managedBotPatch(input: unknown, options: { temporary?: boolean } = {}): Partial<BotRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("bot profile must be an object");
  const value = input as Record<string, unknown>;
  const patch: Partial<BotRecord> = {};

  for (const [key, max] of [["name", 120], ["title", 240], ["description", 4_000]] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") throw new Error(`${key} must be a string`);
    const text = value[key].trim();
    if (key === "name" && !text) throw new Error("name must not be empty");
    if (text.length > max) throw new Error(`${key} is too long (max ${max} characters)`);
    (patch as Record<string, unknown>)[key] = text;
  }
  for (const key of ["notifications", "fastMode", "pinned", "hidden"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") throw new Error(`${key} must be boolean`);
    patch[key] = value[key];
  }
  if (value.color !== undefined) {
    if (!BOT_COLORS.includes(value.color as MausColor)) throw new Error(`color must be one of: ${BOT_COLORS.join(", ")}`);
    patch.color = value.color as MausColor;
  }
  if (value.mascotShape !== undefined) {
    if (typeof value.mascotShape !== "string" || !BOT_SHAPES.includes(value.mascotShape)) {
      throw new Error(`mascotShape must be one of: ${BOT_SHAPES.join(", ")}`);
    }
    patch.mascotShape = value.mascotShape;
  }
  if (value.mascotExpression !== undefined) {
    if (value.mascotExpression !== null && typeof value.mascotExpression !== "string") throw new Error("mascotExpression must be a string or null");
    patch.mascotExpression = value.mascotExpression as string | null;
  }
  if (value.avatarUrl !== undefined) {
    if (value.avatarUrl !== null && typeof value.avatarUrl !== "string") throw new Error("avatarUrl must be a string or null");
    if (typeof value.avatarUrl === "string") {
      if (value.avatarUrl.length > 700_000) throw new Error("avatar image too large (max ~500KB)");
      if (value.avatarUrl && !value.avatarUrl.startsWith("data:image/") && !value.avatarUrl.startsWith("/api/bots/") && !/^https?:\/\//i.test(value.avatarUrl)) {
        throw new Error("avatarUrl must be data:image/*, /api/bots/... or http(s) URL");
      }
    }
    patch.avatarUrl = value.avatarUrl as string | null;
  }
  if (value.modelSelection !== undefined) {
    const selection = value.modelSelection as Record<string, unknown> | null;
    if (!selection || typeof selection !== "object" || Array.isArray(selection) || typeof selection.instanceId !== "string" || !selection.instanceId.trim() || typeof selection.model !== "string" || !selection.model.trim()) {
      throw new Error("modelSelection needs non-empty instanceId and model strings");
    }
    patch.modelSelection = { instanceId: selection.instanceId.trim(), model: selection.model.trim() };
  }
  if (value.section !== undefined) {
    if (value.section !== null && typeof value.section !== "string") throw new Error("section must be a string or null");
    const section = typeof value.section === "string" ? value.section.trim() : "";
    if (section.length > 60) throw new Error("section must be at most 60 characters");
    patch.section = section || undefined;
  }
  if (value.temporary !== undefined) {
    if (!options.temporary) throw new Error("temporary can only be set while creating a bot");
    if (typeof value.temporary !== "boolean") throw new Error("temporary must be boolean");
    patch.temporary = value.temporary;
  }
  return patch;
}

// multibot (F9): głębokość łańcucha ask_bot. Wołający DEKLARUJE ją w ciele
// żądania (proxy dostaje ją w env przy spawnie), ale deklaracja bywa nieaktualna:
// bot silnika ma agents zamontowane na stałe w profilu, więc jego `OMB_TURN_DEPTH`
// zamarza na 0 i każdy hop resetowałby licznik — A→B→A→… bez dna. Harness zna
// prawdziwą głębokość tury, która u wołającego TERAZ trwa, i to ona wygrywa.
/** Głębokość łańcucha dla żądania ask_bot: większa z deklarowanej i faktycznej.
 * `activeDepth` = `commsDepth` tury trwającej u wołającego (undefined = nie ma). */
export function chainDepth(claimed: unknown, activeDepth: number | undefined): number {
  return Math.max(Number(claimed ?? 0) || 0, activeDepth ?? 0);
}

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, names match case-insensitively, longest name wins (so "@New Bot 2"
 * never half-matches "New Bot"), hidden bots skipped, results deduped.
 * Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => rest.startsWith(p.name.toLowerCase()));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

const onboardingCard = (): OptionCardData => ({
  title: "What do you mostly want help with?",
  subtitle: "Pick whatever's closest; we can always expand from there.",
  options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
});

export class Store {
  bots: BotRecord[] = [];
  private messages = new Map<string, Message[]>();
  private defaultSelection: () => ModelSelection;

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch {
      this.bots = [];
    }
    // busy never survives a restart — no turn does either
    for (const b of this.bots) {
      b.busy = false;
      // Ksztalt spoza listy (zapisany, zanim walidacja istniala) rysowal sie
      // na czarno — na wczytaniu wraca do domyslnego bloba.
      if (b.mascotShape !== undefined && !BOT_SHAPES.includes(b.mascotShape)) b.mascotShape = "blob";
    }
  }

  private saveBots() {
    writeFileSync(BOTS_FILE, JSON.stringify(this.bots.filter((bot) => !bot.temporary), null, 2));
  }

  messagesFor(threadId: string): Message[] {
    let list = this.messages.get(threadId);
    if (!list) {
      try {
        const loaded = JSON.parse(readFileSync(messagesFile(threadId), "utf8"));
        list = Array.isArray(loaded) ? loaded : [];
      } catch {
        list = [];
      }
      const normalized = list.map((message, index) => typeof message.order === "number" ? message : { ...message, order: index });
      const ordered = sortMessages(normalized);
      if (ordered.some((message, index) => message !== list![index])) writeFileSync(messagesFile(threadId), JSON.stringify(ordered, null, 2));
      list = ordered;
      this.messages.set(threadId, list);
    }
    return list!;
  }

  /** Transcripts already in memory, for read-only aggregate counting. Going
   * through `messagesFor` instead would cold-load every thread on disk — and
   * that path re-sorts and REWRITES the file, which a GET must never do. */
  residentTranscripts(): Message[][] {
    return [...this.messages.values()];
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    const list = this.messagesFor(threadId);
    const order = list.reduce((max, item) => Math.max(max, item.order ?? -1), -1) + 1;
    const full: Message = { id: newId(), at: Date.now(), ...message, order };
    const ordered = sortMessages([...list, full]);
    this.messages.set(threadId, ordered);
    writeFileSync(messagesFile(threadId), JSON.stringify(ordered, null, 2));
    return full;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const list = this.messagesFor(threadId);
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch, card: patch.card ?? list[idx].card };
    const ordered = sortMessages(list);
    this.messages.set(threadId, ordered);
    writeFileSync(messagesFile(threadId), JSON.stringify(ordered, null, 2));
    return ordered.find((message) => message.id === messageId) ?? null;
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId) ?? null;
  }

  createBot(options: { temporary?: boolean } = {}): BotRecord {
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name: "New Bot",
      title: "",
      description: "",
      notifications: true,
      color: COLORS[this.bots.length % COLORS.length],
      // multibot: Blob — pierwsza ikona z wyboru i domyślna sylwetka nowych botów
      mascotShape: "blob",
      unread: false,
      modelSelection: this.defaultSelection(),
      resumeCursors: {},
      ...(options.temporary ? { temporary: true } : {}),
      createdAt: Date.now(),
    };
    this.bots.unshift(bot);
    this.saveBots();
    this.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: "Hey — I'm your new bot. Nice to meet you.",
    });
    this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
    return bot;
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    this.messages.delete(bot.threadId);
    this.saveBots();
    try {
      unlinkSync(messagesFile(bot.threadId));
    } catch {}
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    this.saveBots();
    return bot;
  }

  /** One-time v2 migration: bind legacy private records to first owner and
   * label anonymous team messages without inventing a human identity. */
  migrateLegacyOwner(userId: string, displayName: string): { bots: number; messages: number } {
    let bots = 0;
    let messages = 0;
    for (const bot of this.bots) {
      if (bot.visibility === "private" && (!bot.ownerId || bot.ownerId === "legacy-token")) {
        bot.ownerId = userId;
        bots++;
      }
      const list = this.messagesFor(bot.threadId);
      let changed = false;
      for (const message of list) {
        if (message.role !== "user" || message.userId || message.userName) continue;
        if (bot.visibility === "private" && bot.ownerId === userId) {
          message.userId = userId;
          message.userName = displayName;
        } else if (bot.visibility !== "private") {
          message.userName = "Legacy member";
        }
        changed = true;
        messages++;
      }
      if (changed) writeFileSync(messagesFile(bot.threadId), JSON.stringify(list, null, 2));
    }
    if (bots) this.saveBots();
    return { bots, messages };
  }

  setChiefOfStaff(id: string, value: boolean): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    const section = bot.section?.trim() ?? "";
    if (value) {
      for (const peer of this.bots) {
        if (peer.id !== id && peer.chiefOfStaff && (peer.section?.trim() ?? "") === section) peer.chiefOfStaff = false;
      }
    }
    bot.chiefOfStaff = value;
    this.saveBots();
    return bot;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown) {
    const bot = this.bot(botId);
    if (!bot) return;
    bot.resumeCursors[instanceId] = cursor;
    this.saveBots();
  }

  /** multibot (G1): repair selections whose instance disappeared from fleet.
   * Prefer a configured custom model, then any live provider, then an explicit
   * empty selection. One write covers every migrated bot. */
  migrateOrphanedSelections(targets: SelectionTarget[]): number {
    const known = new Set(targets.map((target) => target.instanceId));
    // A custom endpoint is a model the user configured by hand, so it still
    // wins over the generic default — see defaultSelectionTarget.
    // `models.default` jest tu warunkiem, nie ozdobą: instancja
    // `openaiImage` istnieje wyłącznie po to, żeby przechować klucz API i nie
    // ma ani adresu, ani modelu — bot przeniesiony na nią nigdy by nie
    // odpowiedział.
    const fallback =
      targets.find((target) => target.driverKind === "openaiCompatible" && Boolean(target.models.default)) ??
      defaultSelectionTarget(targets);
    let changed = 0;
    for (const bot of this.bots) {
      if (known.has(bot.modelSelection.instanceId)) continue;
      bot.modelSelection = fallback
        ? { instanceId: fallback.instanceId, model: fallback.models.default }
        : { instanceId: "", model: "" };
      changed++;
    }
    if (changed) this.saveBots();
    return changed;
  }

  /** First-run seed: one bot so the app never opens empty. */
  seedIfEmpty() {
    if (this.bots.length) return;
    const bot = this.createBot();
    this.patchBot(bot.id, { name: "Milind", color: "blue" });
  }
}
