// multibot: przypomnienia — JEDNORAZOWE „przypomnij mi o X o 9:00".
//
// Osobny rekord, NIE rutyna (decyzja Kacpra 10.09.2026). Rutyna powtarza się i
// żyje harmonogramem; przypomnienie ma jedną chwilę, odpala raz i zostaje w
// historii jako odpalone — z tym, kiedy naprawdę poszło. Własny plik
// (`reminders.json` w DATA_DIR), więc migracji nie ma: stare rutyny z datą ISO
// dalej chodzą swoją ścieżką w `server/routines.ts`, a nowe przypomnienia tą.
//
// `at` zapisujemy jako PEŁNY moment (`toISOString()`, ze strefą), a nie tak,
// jak wpisał go bot. Bot podaje czas lokalny bez offsetu — rozstrzyga go raz
// serwer (`oneShotAt`), dzięki czemu przeglądarka i telefon czytają jedną,
// jednoznaczną chwilę zamiast zgadywać własną strefą.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { newId } from "./contracts.ts";
import { oneShotAt } from "./routines.ts";

export interface Reminder {
  id: string;
  botId: string;
  text: string;
  /** Chwila odpalenia, ISO 8601 ze strefą. */
  at: string;
  createdAt: string;
  firedAt: string | null;
  status: "pending" | "fired";
}

export const REMINDER_TEXT_MAX = 200;
/** Kacper: sprawdzaj co 30 s. Minuta byłaby widocznym spóźnieniem przy
 * przypomnieniu ustawionym „za minutę". */
export const REMINDER_TICK_MS = 30_000;
export const SNOOZE_DEFAULT_MIN = 60;

type Fire = (reminder: Reminder) => void;
type Clock = () => number;

/** Rozstrzyga datę podaną przez bota lub człowieka na konkretną chwilę.
 * Ta sama forma i ta sama strefa co jednorazowy harmonogram rutyny —
 * `oneShotAt` jest jedynym parserem tej daty w całym serwerze. */
export function reminderAtMs(at: string): number {
  const ms = oneShotAt(at);
  if (ms === null) throw new Error("invalid reminder datetime");
  return ms;
}

function writeJsonPrivate(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") {
    if (existsSync(dir)) chmodSync(dir, 0o700);
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

export class Reminders {
  private items: Reminder[] = [];
  private file: string;
  private fire: Fire;
  private now: Clock;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(file: string, fire: Fire, now: Clock = Date.now, tickMs = REMINDER_TICK_MS) {
    this.file = file;
    this.fire = fire;
    this.now = now;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      this.items = Array.isArray(parsed) ? (parsed as Reminder[]) : [];
    } catch {
      this.items = [];
    }
    if (tickMs > 0) {
      this.timer = setInterval(() => this.tick(), tickMs);
      this.timer.unref?.();
      // Restart: przypomnienie, którego termin minął, gdy serwer nie żył, ma
      // odpalić od razu po starcie, a nie po pierwszym pełnym takcie.
      const boot = setTimeout(() => this.tick(), 0);
      boot.unref?.();
    }
  }

  /** Najbliższe najpierw, odpalone na końcu (najświeższe wyżej). Kolejność
   * rozstrzyga serwer, żeby pulpit i telefon nie sortowały jej każdy inaczej. */
  list(botId?: string): Reminder[] {
    const mine = this.items.filter((item) => botId === undefined || item.botId === botId);
    const key = (item: Reminder) => Date.parse(item.at);
    const pending = mine.filter((item) => item.status === "pending").sort((a, b) => key(a) - key(b));
    const fired = mine.filter((item) => item.status !== "pending").sort((a, b) => key(b) - key(a));
    return [...pending, ...fired].map((item) => ({ ...item }));
  }

  get(id: string): Reminder | null {
    const item = this.items.find((entry) => entry.id === id);
    return item ? { ...item } : null;
  }

  create(botId: string, input: { text?: unknown; at?: unknown }): Reminder {
    const text = String(input.text ?? "").trim().slice(0, REMINDER_TEXT_MAX);
    const at = String(input.at ?? "").trim();
    if (!text) throw new Error("text required");
    if (!at) throw new Error("at required");
    const ms = reminderAtMs(at);
    // Przypomnienie na wczoraj nie odpali nigdy — mówimy to od razu, zamiast
    // zapisać martwy rekord, który bot zamelduje jako ustawiony.
    if (ms <= this.now()) throw new Error("reminder time is in the past");
    const item: Reminder = {
      id: newId(),
      botId,
      text,
      at: new Date(ms).toISOString(),
      createdAt: new Date(this.now()).toISOString(),
      firedAt: null,
      status: "pending",
    };
    this.items.push(item);
    this.persist();
    return { ...item };
  }

  delete(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length !== before) this.persist();
    return this.items.length !== before;
  }

  deleteBot(botId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.botId !== botId);
    if (this.items.length !== before) this.persist();
  }

  /** Przesuń o N minut od TERAZ (nie od pierwotnego terminu): „drzemka" ma
   * znaczyć „odezwij się za godzinę", także gdy przypomnienie już odpaliło. */
  snooze(id: string, minutes = SNOOZE_DEFAULT_MIN): Reminder | null {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return null;
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error("minutes must be positive");
    item.at = new Date(this.now() + minutes * 60_000).toISOString();
    item.firedAt = null;
    item.status = "pending";
    this.persist();
    return { ...item };
  }

  tick(): void {
    const now = this.now();
    const due = this.items.filter((item) => item.status === "pending" && Date.parse(item.at) <= now);
    if (due.length === 0) return;
    // Oznacz i ZAPISZ przed wysyłką: crash w połowie odpalania nie może
    // powtórzyć przypomnienia po restarcie.
    const firedAt = new Date(now).toISOString();
    for (const item of due) {
      item.status = "fired";
      item.firedAt = firedAt;
    }
    this.persist();
    for (const item of due) {
      // Jedno wywrócone przypomnienie nie może zabrać ze sobą reszty taktu.
      try {
        this.fire({ ...item });
      } catch (error) {
        console.warn(`[reminders] ${item.id}: ${(error as Error).message}`);
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private persist(): void {
    writeJsonPrivate(this.file, this.items);
  }
}
