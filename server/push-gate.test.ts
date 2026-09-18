// Jedyna bramka „czy to leci na telefon" (`server/push.ts`). Czysta funkcja,
// więc test jest listą przypadków ze specyfikacji Kacpra (K4, 11.09.2026):
// brzęczy to, na co człowiek ma ODPOWIEDZIEĆ, plus przypomnienie i
// `notify_user`. Cykl życia tury milczy — i to jest powód, dla którego RUTYNA
// nie powiadamia o każdym przebiegu.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { allowCardPush, allowNotify, channelForKind, NOTIFY_GAP_MS, PUSH_DEDUP_MS, resetNotifyLimit, shouldNotify, type PushKind } from "./push.ts";

/** Cykl życia tury: to samo, czym kończy się KAŻDY cichy przebieg rutyny. */
const SILENT: PushKind[] = ["started", "finished", "failed"];
/** Bot stoi i czeka na człowieka. */
const WANTS_USER: PushKind[] = ["question", "handoff", "approval", "attention"];

describe("shouldNotify", () => {
  it("przypomnienie: push, o który poprosił człowiek", () => {
    expect(shouldNotify("reminder")).toBe(true);
  });

  it("notify_user: push, o który prosi sam bot", () => {
    expect(shouldNotify("notify")).toBe(true);
  });

  it("pytanie, zgoda, przekazanie komputera, wygasłe logowanie: brzęczy", () => {
    for (const kind of WANTS_USER) expect(shouldNotify(kind)).toBe(true);
  });

  it("start, koniec i awaria tury: cisza — czyli cicha rutyna nie powiadamia", () => {
    for (const kind of SILENT) expect(shouldNotify(kind)).toBe(false);
  });
});

describe("channelForKind", () => {
  it("przypomnienia mają własny kanał, prośby własny", () => {
    expect(channelForKind("reminder")).toBe("reminders");
    for (const kind of [...WANTS_USER, "notify" as PushKind]) expect(channelForKind(kind)).toBe("asks");
  });

  it("wołanie bez rodzaju zostaje na kanale domyślnym", () => {
    expect(channelForKind(undefined)).toBe("default");
    for (const kind of SILENT) expect(channelForKind(kind)).toBe("default");
  });
});

// multibot (K4, recenzja PR #184): osiem zgód w jednej turze albo runda grupy
// dwunastu botów dawały dwanaście brzęczyków o tym samym. Karty zostają
// wszystkie — dedup dotyczy tylko powiadomienia.
describe("allowCardPush", () => {
  it("ten sam rodzaj karty od tego samego bota brzęczy raz w oknie", () => {
    resetNotifyLimit();
    const t0 = 1_000_000;
    expect(allowCardPush("bot-a", "approval", t0)).toBe(true);
    expect(allowCardPush("bot-a", "approval", t0 + 1)).toBe(false);
    expect(allowCardPush("bot-a", "approval", t0 + PUSH_DEDUP_MS - 1)).toBe(false);
    expect(allowCardPush("bot-a", "approval", t0 + PUSH_DEDUP_MS)).toBe(true);
  });

  it("inny rodzaj karty i inny bot mają własne okna", () => {
    resetNotifyLimit();
    const t0 = 1_000_000;
    expect(allowCardPush("bot-a", "approval", t0)).toBe(true);
    expect(allowCardPush("bot-a", "question", t0)).toBe(true);
    expect(allowCardPush("bot-b", "approval", t0)).toBe(true);
  });

  it("przypomnienia, notify_user i wygasłe logowanie NIE są deduplikowane tutaj", () => {
    resetNotifyLimit();
    const t0 = 1_000_000;
    // przypomnienia ustawił człowiek na konkretne godziny — połknięcie
    // drugiego byłoby zgubieniem tego, o co sam poprosił
    for (const kind of ["reminder", "notify", "attention"] as PushKind[]) {
      expect(allowCardPush("bot-a", kind, t0)).toBe(true);
      expect(allowCardPush("bot-a", kind, t0 + 1)).toBe(true);
    }
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

// Bramka bez podpięcia jest martwa, a dwie z tych rzeczy to jedna linia w
// `server/index.ts` — dokładnie taka, jaką łatwo zgubić przy scalaniu.
describe("podpięcie w serwerze", () => {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("pushForBot dedupuje powtórzone karty", () => {
    expect(index).toContain("if (!allowCardPush(botId, kind)) return;");
  });

  it("komunikat o zmianie adresu serwera nie jedzie kanałem próśb bota", () => {
    // `data.kind` tej trasy to „notify", a to `channelForKind` mapuje na
    // `asks` — adres serwera nie jest prośbą bota, więc kanał podany jawnie
    expect(index).toContain('[owner.userId], "default")');
  });
});
