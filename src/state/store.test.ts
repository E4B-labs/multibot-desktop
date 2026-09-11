// multibot (poziom Status): powłoka musi wiedzieć, KTÓRY bot właśnie pracuje na
// wspólnym komputerze — z tego świeci ikona w nagłówku czatu. Lista przychodzi
// w całości ramką `computer-queue` (pole `agentActing`), więc reduktor ją
// podmienia, a nie dokleja.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BOOT_MESSAGES, initialState, reducer, type Bot, type Message } from "@/state/store";

const store = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");

// K7: boot carries only the tail of every transcript; the open bot's history
// comes from `GET /api/bots/:id` and must survive the next resync's tail.
describe("lazy transcripts (K7)", () => {
  const msg = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "text", text: id } as Message);
  const bot = (messages: Message[], truncated?: boolean): Bot =>
    ({ id: "b1", threadId: "t1", name: "B", messages, ...(truncated ? { messagesTruncated: true } : {}) }) as unknown as Bot;

  it("boots the fleet with a bounded tail", () => {
    expect(BOOT_MESSAGES).toBeGreaterThan(0);
    expect(store).toContain("api(`/api/bots?messages=${BOOT_MESSAGES}`)");
  });

  it("botMessages fills in the history and clears the flag, keeping a newer live frame", () => {
    const tail = reducer(initialState, { type: "hydrate", bots: [bot([msg("m9", 9)], true)] });
    expect(tail.bots[0]!.messagesTruncated).toBe(true);
    const live = reducer(tail, { type: "messageAdded", threadId: "t1", message: msg("m10", 10) });
    const full = reducer(live, { type: "botMessages", botId: "b1", messages: [msg("m1", 1), msg("m9", 9)] });
    expect(full.bots[0]!.messages.map((m) => m.id)).toEqual(["m1", "m9", "m10"]);
    expect(full.bots[0]!.messagesTruncated).toBeUndefined();
  });

  it("a resync's tail does not throw away a transcript already loaded in full", () => {
    const full = reducer(initialState, { type: "hydrate", bots: [bot([msg("m1", 1), msg("m9", 9)])] });
    const resynced = reducer(full, { type: "hydrate", bots: [bot([msg("m9", 9), msg("m10", 10)], true)] });
    expect(resynced.bots[0]!.messages.map((m) => m.id)).toEqual(["m1", "m9", "m10"]);
    expect(resynced.bots[0]!.messagesTruncated).toBeUndefined();
  });

  it("a tail for a bot never loaded in full stays flagged, so opening it fetches the rest", () => {
    const first = reducer(initialState, { type: "hydrate", bots: [bot([msg("m9", 9)], true)] });
    const again = reducer(first, { type: "hydrate", bots: [bot([msg("m9", 9)], true)] });
    expect(again.bots[0]!.messagesTruncated).toBe(true);
  });
});

describe("computerActing", () => {
  it("zaczyna pusty — nikt nie klika, dopóki serwer nie powie inaczej", () => {
    expect(initialState.computerActing).toEqual([]);
  });

  it("bierze listę z ramki i czyści ją na końcu tury", () => {
    const working = reducer(initialState, { type: "computerActing", botIds: ["b1"] });
    expect(working.computerActing).toEqual(["b1"]);
    const idle = reducer(working, { type: "computerActing", botIds: [] });
    expect(idle.computerActing).toEqual([]);
  });

  it("ta sama lista nie tworzy nowego stanu (zero przerysowań na każdym narzędziu)", () => {
    const working = reducer(initialState, { type: "computerActing", botIds: ["b1"] });
    expect(reducer(working, { type: "computerActing", botIds: ["b1"] })).toBe(working);
  });

  it("podmienia listę w całości, a nie dokleja", () => {
    const first = reducer(initialState, { type: "computerActing", botIds: ["b1"] });
    expect(reducer(first, { type: "computerActing", botIds: ["b2"] }).computerActing).toEqual(["b2"]);
  });

  // Dokładnie to wyliczenie robi nagłówek czatu: `state.computerActing.includes(bot.id)`.
  // Sygnał jest PER BOT — maszyna jest jedna, ale czat bota, który nic nie robi,
  // świecić nie ma.
  it("akcent zapala się tylko u bota, który pracuje", () => {
    const s = reducer(initialState, { type: "computerActing", botIds: ["b2"] });
    expect(s.computerActing.includes("b2")).toBe(true);
    expect(s.computerActing.includes("b1")).toBe(false);
  });

  it("zerwane połączenie gasi ikonę, bo ramka końca tury już nie przyjdzie", () => {
    const working = reducer(initialState, { type: "computerActing", botIds: ["b1"] });
    expect(reducer(working, { type: "connected", value: false }).computerActing).toEqual([]);
    // Odzyskane połączenie niczego nie zgaduje — czeka na ramkę z serwera.
    expect(reducer(working, { type: "connected", value: true }).computerActing).toEqual(["b1"]);
  });

  // Ramka jest jedna dla całego stanu dzierżawy; brak `agentActing` znaczy
  // „nikt nie pracuje", a nie „nie wiadomo" — inaczej ikona zostawałaby zapalona
  // po turze, bo koniec tury wysyła ramkę BEZ tego pola.
  it("ramka computer-queue bez agentActing czyta się jako pusta lista", () => {
    expect(store).toContain('case "computer-queue":');
    expect(store).toContain("Array.isArray(frame.agentActing) ? frame.agentActing.filter");
  });
});
