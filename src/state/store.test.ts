// multibot (poziom Status): powłoka musi wiedzieć, KTÓRY bot właśnie pracuje na
// wspólnym komputerze — z tego świeci ikona w nagłówku czatu. Lista przychodzi
// w całości ramką `computer-queue` (pole `agentActing`), więc reduktor ją
// podmienia, a nie dokleja.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { initialState, reducer } from "@/state/store";

const store = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");

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
