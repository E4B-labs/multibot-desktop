import { describe, expect, it } from "vitest";

import { mergeMessages, sortMessages } from "./messageOrder";

describe("mergeMessages (K7)", () => {
  it("keeps what only the local copy has and lets the incoming copy win on a duplicate", () => {
    const kept = [{ id: "old", at: 1 }, { id: "dup", at: 2, order: 0 }];
    const incoming = [{ id: "dup", at: 2, order: 5 }, { id: "new", at: 3 }];
    const merged = mergeMessages(kept, incoming);
    expect(merged.map((m) => m.id).sort()).toEqual(["dup", "new", "old"]);
    expect(merged.find((m) => m.id === "dup")?.order).toBe(5);
  });
  it("is the incoming list when nothing was kept", () => {
    expect(mergeMessages([], [{ id: "a", at: 1 }])).toEqual([{ id: "a", at: 1 }]);
  });
});

describe("message order", () => {
  it("uses server insertion order when timestamps match", () => {
    const messages = [
      { id: "z", at: 1_000, order: 1 },
      { id: "a", at: 1_000, order: 0 },
    ];
    expect(sortMessages(messages).map((message) => message.id)).toEqual(["a", "z"]);
  });
});
