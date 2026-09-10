import { describe, expect, it } from "vitest";
import { groupAvatarLayout, groupRowTitle, MAX_GROUP_MEMBERS } from "./groupRow";

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
  it("does not invent unknown members", () => {
    expect(groupAvatarLayout(["a"], 4)).toEqual({ layout: "stack", shown: ["a"], hiddenCount: 2 });
  });
  it("exports the twelve-member cap", () => expect(MAX_GROUP_MEMBERS).toBe(12));
});
