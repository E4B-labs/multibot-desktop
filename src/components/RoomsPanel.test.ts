import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sortRooms } from "./RoomsPanel";
import type { Room } from "@/state/store";

// A bot-to-bot message IS a room turn (PR #48), so "Agent mail" was a second
// ledger for the same thing. It is gone; these checks are the ones that fail
// if it ever grows back. UI tests here are source-string checks: vitest runs in
// node, the repo has no jsdom, and we are not adding one for two assertions.
const SRC = new URL("../", import.meta.url);

function sources(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) return sources(child);
    // Skip test files: this one names MailPanel on purpose.
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [readFileSync(child, "utf8")]
      : [];
  });
}

const room = (over: Partial<Room>): Room => ({
  id: "r",
  name: "n",
  task: "t",
  bot_ids: ["a", "b"],
  transcript: [],
  status: "done",
  createdAt: 0,
  ownerBotId: "a",
  ...over,
});

describe("Bot rooms replace agent mail", () => {
  it("nothing imports MailPanel any more", () => {
    for (const source of sources(SRC)) expect(source).not.toContain("MailPanel");
  });

  it("no mail panel state is left in the store", () => {
    const store = readFileSync(new URL("../state/store.tsx", import.meta.url), "utf8");
    expect(store).not.toContain("mailOpen");
    expect(store).not.toContain("mailThreads");
    expect(store).toContain("roomsOpen");
  });

  it("the panel lists rooms from the store and opens one on click", () => {
    const panel = readFileSync(new URL("./RoomsPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain("state.rooms");
    expect(panel).toContain('type: "toggleRoom", room');
    // No message counter against a limit: a bot↔bot conversation has none.
    expect(panel).not.toContain("roomBudget");
  });

  it("running rooms come first, newest first inside each group", () => {
    const sorted = sortRooms([
      room({ id: "old-done", status: "done", createdAt: 1 }),
      room({ id: "new-done", status: "done", createdAt: 3 }),
      room({ id: "running", status: "running", createdAt: 2 }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["running", "new-done", "old-done"]);
  });

  it("the room header renders every participant, not a fixed pair", () => {
    const panel = readFileSync(new URL("./RoomPanel.tsx", import.meta.url), "utf8");
    expect(panel).not.toContain("members.slice(0, 2)");
    expect(panel).toContain("Owner report");
  });
});
