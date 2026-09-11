import { beforeEach, describe, expect, it } from "vitest";
import {
  noteLocalBotEdit,
  resetPendingBotEdits,
  settleLocalBotEdits,
  stripPendingBotEcho,
} from "./pendingBotEdits";

describe("pending bot edits vs server echo", () => {
  beforeEach(() => resetPendingBotEdits());

  // Szybkie przełączanie kształtu awatara: klik "star" → PATCH w locie →
  // klik "pill" → spóźnione echo z "star" NIE może cofnąć wyboru na stary.
  it("drops stale echoes of fields with an unconfirmed local edit", () => {
    const first = noteLocalBotEdit("b1", ["mascotShape"]);
    const second = noteLocalBotEdit("b1", ["mascotShape"]);

    // Echo pierwszego PATCH-a (stary kształt) przychodzi po drugim kliknięciu.
    expect(stripPendingBotEcho({ id: "b1", mascotShape: "star" })).toEqual({ id: "b1" });

    // Odpowiedź pierwszego PATCH-a nie zwalnia pola — jest nowsza edycja.
    settleLocalBotEdits("b1", first);
    expect(stripPendingBotEcho({ id: "b1", mascotShape: "star" })).toEqual({ id: "b1" });

    // Dopiero potwierdzenie najnowszego PATCH-a oddaje pole serwerowi.
    settleLocalBotEdits("b1", second);
    expect(stripPendingBotEcho({ id: "b1", mascotShape: "pill" })).toEqual({
      id: "b1",
      mascotShape: "pill",
    });
  });

  it("filters only the edited fields and only the edited bot", () => {
    noteLocalBotEdit("b1", ["mascotShape", "color"]);
    // Inne pola tego samego echa (np. busy z runtime'u) przechodzą bez zmian.
    expect(stripPendingBotEcho({ id: "b1", mascotShape: "cloud", color: "red", busy: true })).toEqual({
      id: "b1",
      busy: true,
    });
    // Cudzy bot nie jest maskowany.
    expect(stripPendingBotEcho({ id: "b2", mascotShape: "cloud" })).toEqual({
      id: "b2",
      mascotShape: "cloud",
    });
  });

  it("passes echoes through untouched when nothing is pending", () => {
    const echo = { id: "b1", mascotShape: "star", name: "Bot" };
    expect(stripPendingBotEcho(echo)).toBe(echo);
    // settle bez wpisów nie wybucha
    settleLocalBotEdits("b1", 99);
  });

  it("never strips the id even if someone marks it edited", () => {
    noteLocalBotEdit("b1", ["id", "name"]);
    expect(stripPendingBotEcho({ id: "b1", name: "x" })).toEqual({ id: "b1" });
  });
});
