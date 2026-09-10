// Jedyna bramka „czy to leci na telefon" (`server/push.ts`). Czysta funkcja,
// więc test jest listą przypadków ze specyfikacji Kacpra (10.09.2026):
// przypomnienie brzęczy, `notify_user` brzęczy, cała reszta MILCZY.
import { describe, expect, it } from "vitest";

import { allowNotify, NOTIFY_GAP_MS, resetNotifyLimit, shouldNotify, type PushKind } from "./push.ts";

const SILENT: PushKind[] = ["question", "handoff", "approval", "started", "finished", "failed", "attention"];

describe("shouldNotify", () => {
  it("przypomnienie: jedyny automatyczny push", () => {
    expect(shouldNotify("reminder")).toBe(true);
  });

  it("notify_user: wyjątek, o który prosi sam bot", () => {
    expect(shouldNotify("notify")).toBe(true);
  });

  it("koniec tury, odpowiedź bota, needsAttention, prośby o zgodę: cisza", () => {
    for (const kind of SILENT) expect(shouldNotify(kind)).toBe(false);
  });
});

describe("allowNotify", () => {
  it("pierwsze wołanie przechodzi, kolejne w oknie 10 minut sklejają się", () => {
    resetNotifyLimit();
    const t0 = 1_000_000;
    expect(allowNotify("bot-a", t0)).toBe(true);
    expect(allowNotify("bot-a", t0 + 1)).toBe(false);
    expect(allowNotify("bot-a", t0 + NOTIFY_GAP_MS - 1)).toBe(false);
  });

  it("po oknie bot znów może brzęknąć", () => {
    resetNotifyLimit();
    const t0 = 1_000_000;
    expect(allowNotify("bot-a", t0)).toBe(true);
    expect(allowNotify("bot-a", t0 + NOTIFY_GAP_MS)).toBe(true);
  });

  it("limit jest per bot, nie globalny", () => {
    resetNotifyLimit();
    const t0 = 1_000_000;
    expect(allowNotify("bot-a", t0)).toBe(true);
    expect(allowNotify("bot-b", t0)).toBe(true);
  });
});
