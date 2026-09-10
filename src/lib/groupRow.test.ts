import { describe, expect, it } from "vitest";
import { groupAvatarLayout, groupRowTitle } from "./groupRow";

// Tyle slotów ma każdy układ w GROUP_AVATAR_SLOTS (Sidebar.tsx). Sidebar indeksuje
// tę tablicę numerem awatara, a plakietka „+N" bierze slot za ostatnim awatarem,
// więc awatary RAZEM z plakietką nigdy nie mogą przekroczyć tej liczby.
const SLOTS = { solo: 1, pair: 2, trio: 3 } as const;

describe("groupRowTitle", () => {
  it("joins member names with a comma", () => {
    expect(groupRowTitle(["Szef sztabu", "Nowy"])).toBe("Szef sztabu, Nowy");
  });

  it("is empty for a group with no known members", () => {
    expect(groupRowTitle([])).toBe("");
  });
});

describe("groupAvatarLayout", () => {
  it("gives every member of a small group its own avatar", () => {
    expect(groupAvatarLayout(["a"])).toEqual({ layout: "solo", shown: ["a"], hiddenCount: 0 });
    expect(groupAvatarLayout(["a", "b"])).toEqual({ layout: "pair", shown: ["a", "b"], hiddenCount: 0 });
    expect(groupAvatarLayout(["a", "b", "c"])).toEqual({ layout: "trio", shown: ["a", "b", "c"], hiddenCount: 0 });
  });

  // Od czterech członków klaster to dwa awatary plus plakietka — czyli te same
  // trzy sloty co trójka, więc wiersz nie zmienia kształtu.
  it("swaps the third avatar for a badge from four members up", () => {
    expect(groupAvatarLayout(["a", "b", "c", "d"])).toEqual({ layout: "trio", shown: ["a", "b"], hiddenCount: 2 });
    expect(groupAvatarLayout(["a", "b", "c"], 12)).toEqual({ layout: "trio", shown: ["a", "b"], hiddenCount: 10 });
    for (let total = 4; total <= 12; total++) {
      const { layout, shown, hiddenCount } = groupAvatarLayout(["a", "b", "c"], total);
      expect(layout).toBe("trio");
      expect(shown.length + hiddenCount).toBe(total);
    }
  });

  // Lista grup i lista botów przychodzą osobno, więc grupa potrafi chwilowo mieć
  // więcej członków niż awatarów. Ten, którego nie da się narysować, MUSI wpaść
  // do plakietki — inaczej trójka z jednym nieznanym botem wyglądała jak para.
  it("counts a member it cannot draw into the badge", () => {
    expect(groupAvatarLayout(["a", "b"], 3)).toEqual({ layout: "trio", shown: ["a", "b"], hiddenCount: 1 });
    expect(groupAvatarLayout(["a"], 2)).toEqual({ layout: "pair", shown: ["a"], hiddenCount: 1 });
    expect(groupAvatarLayout(["a"], 4)).toEqual({ layout: "pair", shown: ["a"], hiddenCount: 3 });
  });

  // Sidebar robi GROUP_AVATAR_SLOTS[layout][index] dla awatarów i [shown.length]
  // dla plakietki — brak slotu dałby `undefined` w className i element w lewym
  // górnym rogu pudełka zamiast na swoim miejscu.
  it("fills exactly the slots the layout has", () => {
    const members = ["a", "b", "c", "d", "e"];
    for (let known = 0; known <= members.length; known++) {
      for (let total = 0; total <= 14; total++) {
        const { layout, shown, hiddenCount } = groupAvatarLayout(members.slice(0, known), total);
        const used = shown.length + (hiddenCount > 0 ? 1 : 0);
        expect(used).toBeLessThanOrEqual(SLOTS[layout]);
        // Klaster zawsze mówi prawdę o pełnym składzie: awatary plus plakietka.
        expect(shown.length + hiddenCount).toBe(total);
      }
    }
  });

  it("survives a nonsense count", () => {
    expect(groupAvatarLayout(["a"], -3)).toEqual({ layout: "solo", shown: [], hiddenCount: 0 });
    expect(groupAvatarLayout([], 0)).toEqual({ layout: "solo", shown: [], hiddenCount: 0 });
  });
});
