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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { newId } from "./contracts.ts";
import { oneShotAt } from "./routines.ts";

export interface Reminder {
  id: string;
  botId: string;
  /** Czyje to przypomnienie. Push idzie WYŁĄCZNIE na urządzenia tego
   * użytkownika, a cudze przypomnienia nie wchodzą na jego listę — inaczej
   * „przypomnij MI o dentyście" brzęczałoby całemu zespołowi. `undefined` na
   * instalacji bez kont zachowuje stare zachowanie (wszystkie urządzenia). */
  userId?: string;
  text: string;
  /** Chwila odpalenia, ISO 8601 ze strefą. */
  at: string;
  createdAt: string;
  firedAt: string | null;
  status: "pending" | "fired";
}

export const REMINDER_TEXT_MAX = 200;
/** Kacper: sprawdzaj co 30 s. Minuta byłaby widocznym spóźnieniem przy
 * przypomnieniu ustawionym „za minutę". Testy skracają takt env-em, żeby
 * suita nie czekała pół minuty na każde odpalenie. */
const TICK_MS = Number(process.env.MULTIBOT_REMINDER_TICK_MS) || 30_000;
export const SNOOZE_DEFAULT_MIN = 60;
/** Sufit terminu i drzemki: pięć lat. Rekord na rok 9999 to nie funkcja, tylko
 * literówka modelu, którą trzymalibyśmy w pliku na zawsze. */
const MAX_AHEAD_MS = 5 * 365 * 86_400_000;
/** Ile NIEODPALONYCH przypomnień może mieć jeden bot. `create_reminder` nie
 * wymaga już pełnego dostępu, więc to jedyny hamulec na bota w pętli. */
export const PENDING_PER_BOT_MAX = 50;

type Fire = (reminder: Reminder) => void;
type Clock = () => number;

/** Rozstrzyga datę podaną przez bota lub człowieka na konkretną chwilę.
 * Ta sama forma i ta sama strefa co jednorazowy harmonogram rutyny —
 * `oneShotAt` jest jedynym parserem tej daty w całym serwerze. */
function reminderAtMs(at: string): number {
  const ms = oneShotAt(at);
  if (ms === null) throw new Error("invalid reminder datetime");
  return ms;
}

function writeJsonPrivate(file: string, value: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Zapis przez plik tymczasowy: przerwany `writeFileSync` zostawiłby obcięty
  // JSON, a ten przy starcie wygląda jak „brak przypomnień" i kasuje wszystko.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== "win32") {
    if (existsSync(dir)) chmodSync(dir, 0o700);
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

/** Rekord z dysku, któremu można wierzyć. Data nie do sparsowania dawałaby
 * `NaN <= now === false`, czyli przypomnienie wiszące w „pending" na zawsze i
 * psujące sortowanie listy — lepiej je odrzucić przy wczytaniu. */
function usable(item: unknown): item is Reminder {
  const r = item as Partial<Reminder> | null;
  return Boolean(
    r && typeof r.id === "string" && typeof r.botId === "string" && typeof r.text === "string"
    && typeof r.at === "string" && Number.isFinite(Date.parse(r.at)),
  );
}

export class Reminders {
  private items: Reminder[] = [];
  private file: string;
  private fire: Fire;
  private now: Clock;
  private tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(file: string, fire: Fire, now: Clock = Date.now, tickMs = TICK_MS) {
    this.file = file;
    this.fire = fire;
    this.now = now;
    this.tickMs = tickMs;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      this.items = Array.isArray(parsed) ? parsed.filter(usable) : [];
    } catch {
      this.items = [];
    }
  }

  /** Uruchamia zegar. OSOBNO od konstruktora i wołane dopiero, gdy serwer
   * naprawdę zajął port: drugi proces na tym samym katalogu danych (sonda
   * portu w paczce, przypadkowy `node server/index.ts`) padnie na EADDRINUSE
   * PRZED tym wywołaniem, więc nie odpali cudzych przypomnień po raz drugi. */
  start(): void {
    if (this.timer || this.tickMs <= 0) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    // Zaległe — termin minął, gdy serwer nie żył — mają odpalić od razu po
    // starcie, a nie po pierwszym pełnym takcie.
    const boot = setTimeout(() => this.tick(), 0);
    boot.unref?.();
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

  create(botId: string, input: { text?: unknown; at?: unknown; userId?: string }): Reminder {
    const text = String(input.text ?? "").trim().slice(0, REMINDER_TEXT_MAX);
    const at = String(input.at ?? "").trim();
    if (!text) throw new Error("text required");
    if (!at) throw new Error("at required");
    const ms = reminderAtMs(at);
    // Przypomnienie na wczoraj nie odpali nigdy — mówimy to od razu, zamiast
    // zapisać martwy rekord, który bot zamelduje jako ustawiony.
    if (ms <= this.now()) throw new Error("reminder time is in the past");
    if (ms > this.now() + MAX_AHEAD_MS) throw new Error("reminder time is too far ahead");
    const pending = this.items.filter((item) => item.botId === botId && item.status === "pending").length;
    if (pending >= PENDING_PER_BOT_MAX) throw new Error(`too many pending reminders (max ${PENDING_PER_BOT_MAX})`);
    const item: Reminder = {
      id: newId(),
      botId,
      ...(input.userId ? { userId: input.userId } : {}),
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

  /** Przesuń o N minut. Odpalone liczy od TERAZ („odezwij się za godzinę"),
   * ale CZEKAJĄCE od jego własnego terminu — inaczej jedno kliknięcie
   * „odłóż o godzinę" na przypomnieniu o przyszłym wtorku ściągałoby je na
   * dzisiaj, czyli kasowało termin, o który człowiek prosił. */
  snooze(id: string, minutes = SNOOZE_DEFAULT_MIN): Reminder | null {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return null;
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error("minutes must be positive");
    const from = Math.max(this.now(), Date.parse(item.at));
    const next = from + minutes * 60_000;
    if (next > this.now() + MAX_AHEAD_MS) throw new Error("reminder time is too far ahead");
    item.at = new Date(next).toISOString();
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
    // powtórzyć przypomnienia po restarcie. Gdy zapis padnie (pełny dysk,
    // prawa), cofamy stan i próbujemy w następnym takcie — nieodpalone
    // przypomnienie jest lepsze niż wywrócony serwer albo podwójny push.
    const firedAt = new Date(now).toISOString();
    for (const item of due) {
      item.status = "fired";
      item.firedAt = firedAt;
    }
    try {
      this.persist();
    } catch (error) {
      for (const item of due) {
        item.status = "pending";
        item.firedAt = null;
      }
      console.warn(`[reminders] zapis nieudany, próba w następnym takcie: ${(error as Error).message}`);
      return;
    }
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
