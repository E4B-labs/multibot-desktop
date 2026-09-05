// Collaboration rooms for bot-to-bot tasks. A room is the LEDGER of one
// conversation: every peer message the harness delivers (deliverPeerMessage in
// index.ts) is appended here, and the room's size is what the message budget
// counts. The turns themselves run on the recipients' own main threads.
// Rooms stay available across restarts for inspection.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface RoomMessage {
  id: string;
  /** harness bot id that wrote this */
  from: string;
  text: string;
  at: number;
}

export interface RoomRecord {
  id: string;
  name: string;
  task: string;
  /** participating harness bot ids (originator first) */
  bot_ids: string[];
  transcript: RoomMessage[];
  status: "running" | "done" | "failed";
  createdAt: number;
  /** threadId of the bot chat where the clickable chip lives */
  ownerThread: string;
  /** originator bot id (shown as "X texted Y") */
  ownerBotId: string;
  /** Bot whose turn is currently being generated; null while the room is idle. */
  activeBotId?: string | null;
  /** Recipient of the last message handed over whose turn has not started yet.
   * It survives a restart, so a conversation cut off mid-flight is re-delivered
   * instead of being written off as "the server restarted mid-conversation". */
  pendingTo?: string | null;
  /** Group chat this room mirrors — one room per group, so a group keeps a
   * single ledger (and a single budget) instead of a room per message. */
  groupId?: string;
}

/** How many more messages this room may carry before the budget is spent. */
export function budgetLeft(room: RoomRecord, max: number): number {
  return Math.max(0, max - room.transcript.length);
}

/** A bot repeating itself verbatim is a loop, not a contribution. */
export function isDuplicateOfLast(room: RoomRecord, from: string, text: string): boolean {
  const last = [...room.transcript].reverse().find((message) => message.from === from);
  return Boolean(last && last.text.trim() === text.trim());
}

/** A bot ends its room contribution with this exact line once the task is
 * resolved; the harness strips it from the visible transcript. */
export const ROOM_DONE_MARKER = "[TASK COMPLETE]";

/** Words only, lowercased — punctuation and casing are not content. */
const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Same thing said twice, allowing for a reworded sentence. Jaccard over word
 * sets: cheap, no dependency, and "Confirmed." vs "Potwierdzone." still differ
 * (they are caught by the length rule instead). */
function nearDuplicate(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const mine = new Set(left.split(" "));
  const theirs = new Set(right.split(" "));
  let shared = 0;
  for (const word of mine) if (theirs.has(word)) shared += 1;
  return shared / Math.max(mine.size, theirs.size) >= 0.8;
}

/** Longest a contentless reply may be and still count as a pleasantry. */
const ACK_MAX_CHARS = 200;
/** How many messages back, per side, the "no new information" check looks. */
const NO_NEW_INFO_WINDOW = 4;
/** Words that carry no work in either language MultiBot is used in, plus the
 * glue between them. A short message made only of these says nothing.
 *
 * Deliberately WITHOUT yes/no/tak/nie/done/gotowe/zrobione: those are answers.
 * "Done." to "did you deploy it" is a result, and swallowing it would leave the
 * asker waiting forever — the opposite of the bug this list exists to fix.
 * ponytail: a word list, not a classifier — extend it when a new pleasantry
 * shows up in a transcript. */
const ACK_WORDS = new Set(
  ("ok okay oki ack acked acknowledged confirm confirmed confirming agree agreed agreement noted understood"
    + " thanks thank sure sounds good great perfect roger received"
    + " potwierdzone potwierdzam potwierdzenie zgoda zgadza sie się jasne dobra dobrze dziekuje dziękuję dzieki dzięki"
    + " rozumiem przyjete przyjęte super swietnie świetnie oczywiscie oczywiście"
    + " i a the to it is that we and then now for of on w na z za ale juz już bardzo").split(" "),
);
const words = (text: string): string[] => normalize(text).split(" ").filter(Boolean);

/**
 * "Confirmed." / "Potwierdzone." — a reply that carries nothing new. Two bots
 * politely agreeing with each other bounced eleven times and burned a whole
 * 24-message budget in a live demo, so the harness refuses to spend a turn on
 * one: it is recorded in the room and the exchange stops there.
 *
 * A reply is never an acknowledgement when it asks something (`?`), hands the
 * work to someone (`@Name`) or declares the task finished — those carry the
 * conversation. Past that it is one of two things: a short message made only
 * of pleasantries, or a message that just says again what it or the other side
 * already said.
 */
export function isAcknowledgement(room: RoomRecord, from: string, text: string): boolean {
  const body = text.trim();
  if (!body) return false;
  if (body.includes("?") || body.includes(ROOM_DONE_MARKER)) return false;
  if (/@[\p{L}\p{N}]/u.test(body)) return false;
  const reversed = [...room.transcript].reverse();
  const theirLast = reversed.find((m) => m.from !== from)?.text;
  // Somebody asked something: whatever comes back is the answer, however short
  // and however polite. Swallowing it would leave the asker waiting forever.
  if (theirLast?.includes("?")) return false;
  if (body.length < ACK_MAX_CHARS && words(body).every((word) => ACK_WORDS.has(word))) return true;
  // Against the last few messages from EACH side, not just the newest one: two
  // bots rotating three rephrasings of the same point never repeat the message
  // directly before them, so a one-message window let the loop straight through.
  const recent = [
    ...reversed.filter((m) => m.from === from).slice(0, NO_NEW_INFO_WINDOW),
    ...reversed.filter((m) => m.from !== from).slice(0, NO_NEW_INFO_WINDOW),
  ];
  return recent.some((m) => nearDuplicate(body, m.text));
}

const ROOMS_FILE = join(DATA_DIR, "rooms.json");

export class RoomStore {
  private rooms = new Map<string, RoomRecord>();
  private readonly filePath: string;
  /** Rooms whose turn died with the previous process. They keep the "running"
   * status so the harness can RESUME them at boot (re-deliver `pendingTo`);
   * only the harness knows the budget and the clock, and only it can reach a
   * chat to report the ones that are genuinely spent. */
  readonly recovered: string[] = [];

  constructor(filePath = ROOMS_FILE) {
    this.filePath = filePath;
    try {
      const saved = JSON.parse(readFileSync(this.filePath, "utf8")) as RoomRecord[];
      for (const room of saved) {
        if (!room || typeof room.id !== "string" || !Array.isArray(room.bot_ids) || !Array.isArray(room.transcript)) continue;
        if (!["running", "done", "failed"].includes(room.status)) continue;
        this.rooms.set(room.id, {
          ...room,
          bot_ids: [...room.bot_ids],
          transcript: room.transcript.map((message) => ({ ...message })),
          // The status is preserved: a live conversation stays live across a
          // restart and the harness decides at boot whether to resume it.
          activeBotId: null,
        });
        if (room.status === "running") this.recovered.push(room.id);
      }
    } catch {
      // First run or unreadable old file: start with no rooms.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...this.rooms.values()], null, 2));
  }

  create(input: { task: string; bot_ids: string[]; ownerThread: string; ownerBotId: string; groupId?: string }): RoomRecord {
    const now = Date.now();
    const room: RoomRecord = {
      id: newId(),
      name: input.task.length > 48 ? `${input.task.slice(0, 48)}…` : input.task,
      task: input.task,
      bot_ids: [...input.bot_ids],
      transcript: [],
      status: "running",
      createdAt: now,
      ownerThread: input.ownerThread,
      ownerBotId: input.ownerBotId,
      activeBotId: null,
      ...(input.groupId ? { groupId: input.groupId } : {}),
    };
    this.rooms.set(room.id, room);
    this.persist();
    return this.get(room.id)!;
  }

  get(id: string): RoomRecord | null {
    const room = this.rooms.get(id);
    return room
      ? { ...room, bot_ids: [...room.bot_ids], transcript: room.transcript.map((m) => ({ ...m })) }
      : null;
  }

  list(): RoomRecord[] {
    return [...this.rooms.values()].map((r) => this.get(r.id)!);
  }

  /** The open room a group already talks in, so a group keeps one ledger. */
  forGroup(groupId: string): RoomRecord | null {
    const room = [...this.rooms.values()].find((r) => r.groupId === groupId && r.status === "running");
    return room ? this.get(room.id) : null;
  }

  /** The open room these bots already share — reuse it instead of opening a
   * second ledger for the same conversation. */
  runningWith(botIds: string[]): RoomRecord | null {
    const room = [...this.rooms.values()].find(
      (r) => r.status === "running" && !r.groupId && botIds.every((id) => r.bot_ids.includes(id)),
    );
    return room ? this.get(room.id) : null;
  }

  /** A conversation may pull in a third bot; the room follows it. */
  addBot(id: string, botId: string): RoomRecord | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    if (!room.bot_ids.includes(botId)) {
      room.bot_ids.push(botId);
      this.persist();
    }
    return this.get(id);
  }

  append(id: string, from: string, text: string): RoomMessage | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    const message: RoomMessage = { id: newId(), from, text, at: Date.now() };
    room.transcript.push(message);
    this.persist();
    return { ...message };
  }

  /** multibot: strumień tury dokleja do JEDNEJ wiadomości zamiast mnożyć
   * dymki — bufor spłukuje w losowym miejscu, nawet w połowie wyrazu. */
  appendToMessage(id: string, messageId: string, extra: string): RoomMessage | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    const message = room.transcript.find((m) => m.id === messageId);
    if (!message) return null;
    message.text += extra;
    this.persist();
    return { ...message };
  }

  setStatus(id: string, status: RoomRecord["status"]): RoomRecord | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    room.status = status;
    this.persist();
    return this.get(id);
  }

  /** Remember (or forget) who owes this room a turn, so a restart can resume. */
  setPending(id: string, pendingTo: string | null): RoomRecord | null {
    const room = this.rooms.get(id);
    if (!room || (room.pendingTo ?? null) === pendingTo) return room ? this.get(id) : null;
    room.pendingTo = pendingTo;
    this.persist();
    return this.get(id);
  }

  setActiveBot(id: string, activeBotId: string | null): RoomRecord | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    room.activeBotId = activeBotId;
    this.persist();
    return this.get(id);
  }

  delete(id: string): boolean {
    const deleted = this.rooms.delete(id);
    if (deleted) this.persist();
    return deleted;
  }
}
