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
    expect(groupAvatarStack(["a", "b"])).toEqual({ shown: ["a", "b"] });
  });

  it("keeps every known avatar instead of collapsing the rest into +N", () => {
    expect(groupAvatarStack(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b", "c", "d"] });
  });

  it("does not invent avatars for unknown bots", () => {
    expect(groupAvatarStack(["a", "b"])).toEqual({ shown: ["a", "b"] });
  });

  it("shows a single avatar for a one-member group", () => {
    expect(groupAvatarStack(["a"])).toEqual({ shown: ["a"] });
  });
});
