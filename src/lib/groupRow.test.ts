import { describe, expect, it } from "vitest";
import { groupAvatarLayout, groupRowTitle } from "./groupRow";

// Tyle slotów ma każdy układ w GROUP_AVATAR_SLOTS (Sidebar.tsx). Sidebar indeksuje
// tę tablicę numerem awatara, więc `shown` nigdy nie może być dłuższe.
const SLOTS = { solo: 1, pair: 2, trio: 3, stack: 2 } as const;

describe("groupRowTitle", () => {
  it("joins member names with a comma", () => {
    expect(groupRowTitle(["Szef sztabu", "Nowy"])).toBe("Szef sztabu, Nowy");
  });

  it("is empty for a group with no known members", () => {
    expect(groupRowTitle([])).toBe("");
  });
});

describe("groupAvatarLayout", () => {
  it("covers solo, pair, trio, and stack layouts", () => {
    expect(groupAvatarLayout(["a"])).toEqual({ layout: "solo", shown: ["a"], hiddenCount: 0 });
    expect(groupAvatarLayout(["a", "b"])).toEqual({ layout: "pair", shown: ["a", "b"], hiddenCount: 0 });
    expect(groupAvatarLayout(["a", "b", "c"])).toEqual({ layout: "trio", shown: ["a", "b", "c"], hiddenCount: 0 });
    expect(groupAvatarLayout(["a", "b", "c", "d"])).toEqual({ layout: "stack", shown: ["a", "b"], hiddenCount: 2 });
  });
  // Skasowanie bota nie wyjmuje go z `bot_ids`, więc grupa potrafi mieć więcej
  // członków niż awatarów. Układ idzie wtedy za tym, co da się narysować.
  it("falls back to the layout it can actually draw", () => {
    expect(groupAvatarLayout(["a"], 2)).toEqual({ layout: "solo", shown: ["a"], hiddenCount: 0 });
    expect(groupAvatarLayout(["a", "b"], 3)).toEqual({ layout: "pair", shown: ["a", "b"], hiddenCount: 0 });
  });

  it("counts the badge up to the full membership", () => {
    expect(groupAvatarLayout(["a"], 4)).toEqual({ layout: "stack", shown: ["a"], hiddenCount: 3 });
    expect(groupAvatarLayout(["a", "b", "c"], 12)).toEqual({ layout: "stack", shown: ["a", "b"], hiddenCount: 10 });
    for (let total = 4; total <= 12; total++) {
      const { shown, hiddenCount } = groupAvatarLayout(["a", "b", "c"], total);
      expect(shown.length + hiddenCount).toBe(total);
    }
  });

  // Sidebar robi GROUP_AVATAR_SLOTS[layout][index] — brak slotu dałby `undefined`
  // w className i awatar w lewym górnym rogu pudełka zamiast na swoim miejscu.
  it("never asks for more slots than the layout has", () => {
    const members = ["a", "b", "c", "d", "e"];
    for (let known = 0; known <= members.length; known++) {
      for (let total = 0; total <= 14; total++) {
        const { layout, shown } = groupAvatarLayout(members.slice(0, known), total);
        expect(shown.length).toBeLessThanOrEqual(SLOTS[layout]);
      }
    }
  });

  it("survives a nonsense count", () => {
    expect(groupAvatarLayout(["a"], -3)).toEqual({ layout: "solo", shown: [], hiddenCount: 0 });
    expect(groupAvatarLayout([], 0)).toEqual({ layout: "solo", shown: [], hiddenCount: 0 });
  });
});
