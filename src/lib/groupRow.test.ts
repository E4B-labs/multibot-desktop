import { describe, expect, it } from "vitest";
import { groupAvatarStack, groupRowTitle } from "./groupRow";

describe("groupRowTitle", () => {
  it("joins member names with a comma", () => {
    expect(groupRowTitle(["Szef sztabu", "Nowy"])).toBe("Szef sztabu, Nowy");
  });

  it("is empty for a group with no known members", () => {
    expect(groupRowTitle([])).toBe("");
  });
});

describe("groupAvatarStack", () => {
  it("keeps both known avatars in the horizontal stack", () => {
    expect(groupAvatarStack(["a", "b"])).toEqual({ shown: ["a", "b"], hiddenCount: 0 });
  });

  it("shows at most three avatars and counts every remaining member", () => {
    expect(groupAvatarStack(["a", "b", "c"])).toEqual({ shown: ["a", "b", "c"], hiddenCount: 0 });
    expect(groupAvatarStack(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b", "c"], hiddenCount: 1 });
    expect(groupAvatarStack(["a", "b", "c", "d", "e"])).toEqual({ shown: ["a", "b", "c"], hiddenCount: 2 });
  });

  it("counts overflow from the full membership when not every bot is known", () => {
    expect(groupAvatarStack(["a", "b", "c", "d"], 5)).toEqual({
      shown: ["a", "b", "c"],
      hiddenCount: 2,
    });
  });

  it("does not invent avatars for unknown bots", () => {
    expect(groupAvatarStack(["a", "b"])).toEqual({ shown: ["a", "b"], hiddenCount: 0 });
  });

  it("shows a single avatar for a one-member group", () => {
    expect(groupAvatarStack(["a"])).toEqual({ shown: ["a"], hiddenCount: 0 });
  });
});
