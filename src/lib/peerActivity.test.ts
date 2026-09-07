import { describe, expect, it } from "vitest";
import { peerActivityGroupFor } from "./peerActivity";

const room = (id: string, event: "texted" | "received", ownerBotId: string, peerId: string) => ({
  id,
  event,
  ownerBotId,
  bot_ids: [ownerBotId, peerId],
});

describe("peer activity grouping", () => {
  it("groups adjacent messages sent to several agents in one room", () => {
    const messages = [
      { id: "one", room: room("room-1", "texted", "red", "pink") },
      { id: "two", room: room("room-1", "texted", "red", "yellow") },
      { id: "three", room: room("room-1", "received", "red", "yellow") },
    ];

    expect(peerActivityGroupFor(messages, 0, "red")?.map((message) => message.id)).toEqual(["one", "two"]);
    expect(peerActivityGroupFor(messages, 1, "red")?.map((message) => message.id)).toEqual(["one", "two"]);
    expect(peerActivityGroupFor(messages, 2, "yellow")?.map((message) => message.id)).toEqual(["three"]);
  });

  it("does not merge separate rooms or received markers", () => {
    const messages = [
      { id: "one", room: room("room-1", "texted", "red", "pink") },
      { id: "two", room: room("room-2", "texted", "red", "yellow") },
      { id: "three", room: room("room-1", "received", "red", "yellow") },
    ];

    expect(peerActivityGroupFor(messages, 0, "red")?.map((message) => message.id)).toEqual(["one"]);
    expect(peerActivityGroupFor(messages, 1, "red")?.map((message) => message.id)).toEqual(["two"]);
    expect(peerActivityGroupFor(messages, 2, "yellow")?.map((message) => message.id)).toEqual(["three"]);
  });
});
