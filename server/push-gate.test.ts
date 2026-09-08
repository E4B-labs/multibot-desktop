// Jedyna bramka „czy to warte powiadomienia" (`server/push.ts`). Czysta
// funkcja, więc test jest listą przypadków ze specyfikacji, a nie harnessem:
// gadanie botów i start tury milczą, odpowiedź dla człowieka, przypomnienie i
// prośba o decyzję brzęczą.
import { describe, expect, it } from "vitest";

import { shouldNotify } from "./push.ts";

describe("shouldNotify", () => {
  it("wiadomość bot-bot (pokój, peer): cisza", () => {
    expect(shouldNotify({ kind: "notify", origin: "bot" })).toBe(false);
    expect(shouldNotify({ kind: "finished", origin: "bot" })).toBe(false);
    expect(shouldNotify({ kind: "failed", origin: "bot" })).toBe(false);
  });

  it("start tury: cisza niezależnie od tego, kto ją zaczął", () => {
    expect(shouldNotify({ kind: "started", origin: "user" })).toBe(false);
    expect(shouldNotify({ kind: "started", origin: "routine" })).toBe(false);
    expect(shouldNotify({ kind: "started", origin: "bot" })).toBe(false);
  });

  it("koniec tury człowieka w jego czacie: push", () => {
    expect(shouldNotify({ kind: "finished", origin: "user" })).toBe(true);
    expect(shouldNotify({ kind: "notify", origin: "user" })).toBe(true);
  });

  it("przypomnienie: push także wtedy, gdy akurat trwa praca bot-bot", () => {
    expect(shouldNotify({ kind: "reminder", origin: "routine" })).toBe(true);
    expect(shouldNotify({ kind: "reminder", origin: "bot" })).toBe(true);
  });

  it("prośba o zgodę, sekret i przekazanie komputera: push zawsze", () => {
    for (const origin of ["user", "routine", "bot"] as const) {
      expect(shouldNotify({ kind: "approval", origin })).toBe(true);
      expect(shouldNotify({ kind: "question", origin })).toBe(true);
      expect(shouldNotify({ kind: "handoff", origin })).toBe(true);
      expect(shouldNotify({ kind: "attention", origin })).toBe(true);
    }
  });

  it("brak znanego pochodzenia tury nie wycisza powiadomienia", () => {
    expect(shouldNotify({ kind: "finished" })).toBe(true);
    expect(shouldNotify({ kind: "reminder" })).toBe(true);
  });
});
