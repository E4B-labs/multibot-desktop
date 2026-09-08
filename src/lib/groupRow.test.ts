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
  it("stacks both members when the group has exactly two", () => {
    expect(groupAvatarStack(["a", "b"])).toEqual({ shown: ["a", "b"], plus: 0 });
  });

  it("keeps one avatar and counts the rest behind a +N badge", () => {
    expect(groupAvatarStack(["a", "b", "c", "d"])).toEqual({ shown: ["a"], plus: 3 });
  });

  it("counts unknown bots via the total member count", () => {
    expect(groupAvatarStack(["a", "b"], 5)).toEqual({ shown: ["a"], plus: 4 });
  });

  it("shows a single avatar for a one-member group", () => {
    expect(groupAvatarStack(["a"])).toEqual({ shown: ["a"], plus: 0 });
  });
});
