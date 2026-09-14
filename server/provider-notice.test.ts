import { describe, expect, it } from "vitest";
import { isContextCompactionNotice } from "./provider-notice.ts";

describe("provider notices", () => {
  it("recognizes context-compaction notices", () => {
    expect(isContextCompactionNotice("Compacting conversation…")).toBe(true);
    expect(isContextCompactionNotice("Conversation compacted")).toBe(true);
    expect(isContextCompactionNotice("I compacted the notes you asked for")).toBe(false);
  });
});
