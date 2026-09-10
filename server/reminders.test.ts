// multibot: przypomnienia jako OSOBNY rekord (nie rutyna). Testujemy to, co
// naprawdę może się zepsuć: odpalenie dokładnie raz, przeżycie restartu,
// walidację daty, drzemkę i sprzątanie po skasowanym bocie.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Reminders, type Reminder } from "./reminders.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mb-reminders-"));
  file = join(dir, "reminders.json");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** Zegar sterowany ręcznie — przypomnienia mierzą czas TYM, nie `Date.now()`. */
function clock(start: number) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("Reminders", () => {
  it("odpala raz i tylko raz, choćby takt przyszedł dziesięć razy", () => {
    const time = clock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const fired: Reminder[] = [];
    const reminders = new Reminders(file, (r) => fired.push(r), time.now, 0);
    reminders.create("bot-a", { text: "kawa", at: iso(time.now() + 60_000) });

    reminders.tick();
    expect(fired).toHaveLength(0); // jeszcze nie czas

    time.advance(60_000);
    for (let i = 0; i < 10; i++) reminders.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0].text).toBe("kawa");
  });

  it("takt z fake timers odpala przypomnienie i nie powtarza go w kolejnych", () => {
    const start = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const fired: Reminder[] = [];
    // domyślny zegar (Date.now) + własny takt 30 s, oba pod kontrolą vitest
    const reminders = new Reminders(file, (r) => fired.push(r), Date.now, 30_000);
    reminders.create("bot-a", { text: "dentysta", at: iso(start + 60_000) });

    vi.advanceTimersByTime(30_000);
    expect(fired).toHaveLength(0);
    vi.advanceTimersByTime(30_000);
    expect(fired).toHaveLength(1);
    // pięć kolejnych taktów po terminie: nadal jedno odpalenie
    vi.advanceTimersByTime(5 * 30_000);
    expect(fired).toHaveLength(1);
    reminders.stop();
  });

  it("restart: termin minął, gdy serwer nie żył — odpala po starcie, ale raz", () => {
    const start = Date.UTC(2026, 8, 10, 12, 0, 0);
    const first = clock(start);
    const before = new Reminders(file, () => {}, first.now, 0);
    before.create("bot-a", { text: "leki", at: iso(start + 60_000) });

    // nowa instancja z tego samego pliku, już po terminie
    const later = clock(start + 10 * 60_000);
    const fired: Reminder[] = [];
    const after = new Reminders(file, (r) => fired.push(r), later.now, 0);
    after.tick();
    expect(fired).toHaveLength(1);
    after.tick();
    expect(fired).toHaveLength(1);

    // a trzecia instancja nie odpala go już wcale — stan siedzi w pliku
    const third = new Reminders(file, (r) => fired.push(r), later.now, 0);
    third.tick();
    expect(fired).toHaveLength(1);
  });

  it("stan odpalenia zapisuje się PRZED wysyłką, więc crash w połowie nie powtarza", () => {
    const time = clock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const reminders = new Reminders(file, () => {
      // w chwili wysyłki plik musi już mówić „fired"
      const saved = JSON.parse(readFileSync(file, "utf8")) as Reminder[];
      expect(saved[0].status).toBe("fired");
      expect(saved[0].firedAt).not.toBeNull();
      throw new Error("push padł");
    }, time.now, 0);
    reminders.create("bot-a", { text: "kawa", at: iso(time.now() + 1_000) });
    time.advance(1_000);
    expect(() => reminders.tick()).not.toThrow();
    expect(reminders.list("bot-a")[0].status).toBe("fired");
  });

  it("data w przeszłości i śmieć zamiast daty: błąd od razu, nie martwy rekord", () => {
    const time = clock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const reminders = new Reminders(file, () => {}, time.now, 0);
    expect(() => reminders.create("bot-a", { text: "x", at: iso(time.now() - 1_000) }))
      .toThrow(/in the past/);
    expect(() => reminders.create("bot-a", { text: "x", at: "jutro o 9" }))
      .toThrow(/invalid reminder datetime/);
    expect(() => reminders.create("bot-a", { text: "", at: iso(time.now() + 1_000) }))
      .toThrow(/text required/);
    expect(reminders.list()).toHaveLength(0);
  });

  it("lista: najbliższe najpierw, odpalone na końcu", () => {
    const time = clock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const reminders = new Reminders(file, () => {}, time.now, 0);
    reminders.create("bot-a", { text: "późne", at: iso(time.now() + 3 * 60_000) });
    reminders.create("bot-a", { text: "wczesne", at: iso(time.now() + 60_000) });
    const stale = reminders.create("bot-b", { text: "minione", at: iso(time.now() + 30_000) });
    time.advance(30_000);
    reminders.tick();

    expect(reminders.list().map((r) => r.text)).toEqual(["wczesne", "późne", "minione"]);
    expect(reminders.list("bot-a").map((r) => r.text)).toEqual(["wczesne", "późne"]);
    expect(reminders.get(stale.id)?.status).toBe("fired");
  });

  it("drzemka liczy się od TERAZ i wskrzesza odpalone przypomnienie", () => {
    const time = clock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const fired: Reminder[] = [];
    const reminders = new Reminders(file, (r) => fired.push(r), time.now, 0);
    const item = reminders.create("bot-a", { text: "kawa", at: iso(time.now() + 1_000) });
    time.advance(1_000);
    reminders.tick();
    expect(fired).toHaveLength(1);

    const snoozed = reminders.snooze(item.id, 60);
    expect(snoozed?.status).toBe("pending");
    expect(snoozed?.firedAt).toBeNull();
    expect(Date.parse(snoozed!.at)).toBe(time.now() + 60 * 60_000);

    time.advance(60 * 60_000);
    reminders.tick();
    expect(fired).toHaveLength(2);
    expect(reminders.snooze("nie-ma", 60)).toBeNull();
  });

  it("kasowanie pojedyncze i sprzątanie po bocie", () => {
    const time = clock(Date.UTC(2026, 8, 10, 12, 0, 0));
    const reminders = new Reminders(file, () => {}, time.now, 0);
    const a = reminders.create("bot-a", { text: "a", at: iso(time.now() + 60_000) });
    reminders.create("bot-b", { text: "b", at: iso(time.now() + 60_000) });
    expect(reminders.delete(a.id)).toBe(true);
    expect(reminders.delete(a.id)).toBe(false);
    reminders.deleteBot("bot-b");
    expect(reminders.list()).toHaveLength(0);
  });

  it("uszkodzony plik nie wywraca startu serwera", () => {
    writeFileSync(file, "{ to nie jest JSON");
    const reminders = new Reminders(file, () => {}, Date.now, 0);
    expect(reminders.list()).toEqual([]);
  });
});
