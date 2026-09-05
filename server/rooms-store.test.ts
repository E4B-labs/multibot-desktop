import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetLeft, isAcknowledgement, isDuplicateOfLast, RoomStore, type RoomRecord } from "./rooms.ts";

/** Bare ledger — the two helpers only read `transcript`. */
const roomWith = (transcript: Array<{ from: string; text: string }>): RoomRecord => ({
  id: "r",
  name: "r",
  task: "r",
  bot_ids: ["a", "b"],
  transcript: transcript.map((m, i) => ({ id: String(i), at: i, ...m })),
  status: "running",
  createdAt: 0,
  ownerThread: "t",
  ownerBotId: "a",
});

describe("budgetLeft", () => {
  it("counts down with the transcript and never goes negative", () => {
    expect(budgetLeft(roomWith([]), 4)).toBe(4);
    expect(budgetLeft(roomWith([{ from: "a", text: "1" }, { from: "b", text: "2" }]), 4)).toBe(2);
    const spent = roomWith([1, 2, 3, 4, 5].map((n) => ({ from: "a", text: String(n) })));
    expect(budgetLeft(spent, 4)).toBe(0);
  });
});

describe("isDuplicateOfLast", () => {
  const room = roomWith([{ from: "a", text: "status?" }, { from: "b", text: "working on it" }]);
  it("catches a bot repeating its own last line, ignoring surrounding space", () => {
    expect(isDuplicateOfLast(room, "b", "  working on it \n")).toBe(true);
    expect(isDuplicateOfLast(room, "b", "done")).toBe(false);
  });
  it("compares against that bot's own last line, not the room's newest", () => {
    expect(isDuplicateOfLast(room, "a", "status?")).toBe(true);
    expect(isDuplicateOfLast(room, "a", "working on it")).toBe(false);
  });
  it("is false when that bot has not spoken yet", () => {
    expect(isDuplicateOfLast(roomWith([{ from: "a", text: "hi" }]), "b", "hi")).toBe(false);
  });
});

describe("RoomStore", () => {
  it("keeps collaboration transcript available after reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "multibot-rooms-"));
    const file = join(dir, "rooms.json");
    try {
      const first = new RoomStore(file);
      const room = first.create({ task: "inspect the change", bot_ids: ["atlas", "personal"], ownerThread: "thread-a", ownerBotId: "atlas" });
      first.append(room.id, "atlas", "I checked the change.");
      first.setStatus(room.id, "done");

      const reopened = new RoomStore(file).get(room.id);
      expect(reopened).toMatchObject({
        task: "inspect the change",
        bot_ids: ["atlas", "personal"],
        status: "done",
        transcript: [{ from: "atlas", text: "I checked the change." }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The live-demo loop: Atlas and Gatekeeper traded "confirmed" / "Potwierdzone"
// eleven times until the message budget died. An acknowledgement is a line in
// the ledger, never another turn.
describe("isAcknowledgement", () => {
  const room = roomWith([
    { from: "a", text: "Deploy is out, everything green." },
    { from: "b", text: "Great, thanks." },
  ]);

  it("catches a bare pleasantry in either language", () => {
    for (const text of ["Confirmed.", "Potwierdzone.", "ok", "Dzięki, jasne", "Sounds good, thanks!", "Zgoda"]) {
      expect(isAcknowledgement(room, "a", text)).toBe(true);
    }
  });

  it("lets a question, a handoff and the done marker through", () => {
    expect(isAcknowledgement(room, "a", "Which build should I check?")).toBe(false);
    expect(isAcknowledgement(room, "a", "That one is for @Researcher")).toBe(false);
    expect(isAcknowledgement(room, "a", "All wrapped up.\n[TASK COMPLETE]")).toBe(false);
  });

  it("lets a short RESULT through - brevity alone is not emptiness", () => {
    for (const text of ["Build 4412 failed on the lint step.", "room work from fake", "Done.", "Zrobione", "Gotowe", "No.", "Nie gotowe", "Tak"]) {
      expect(isAcknowledgement(room, "a", text), `zjadło odpowiedź: ${text}`).toBe(false);
    }
  });

  // A yes/no answer is the shortest content there is; the brake must never
  // stand between a question and its answer.
  it("never swallows a reply to a question", () => {
    const asked = roomWith([{ from: "b", text: "Czy deploy przeszedł?" }]);
    for (const text of ["Nie", "Tak", "Potwierdzone.", "ok"]) {
      expect(isAcknowledgement(asked, "a", text), `zjadło odpowiedź na pytanie: ${text}`).toBe(false);
    }
  });

  it("catches a long answer that only says again what was just said", () => {
    const said = "The migration ran on staging, the row counts match, and I archived the old table."
      + " Nothing else is outstanding on my side, so this stage is finished from where I sit."
      + " I left the rollback script in the shared drive under migrations, next to the checklist.";
    const reworded = "The migration ran on staging, row counts match, and I have archived that old table."
      + " Nothing else is outstanding here, so this whole stage is finished from where I sit."
      + " I left the rollback script in the shared drive under migrations, beside the checklist.";
    const long = roomWith([{ from: "a", text: said }]);
    expect(said.length).toBeGreaterThan(200);
    expect(isAcknowledgement(long, "b", reworded)).toBe(true);
    expect(isAcknowledgement(long, "b", `${said.slice(0, 120)} But the index rebuild is still queued behind the nightly job and nobody owns it yet.`)).toBe(false);
  });

  // Two bots rotating three wordings of the same point never repeat the message
  // directly before them, so a one-message window let the loop run to the end of
  // the count. The detector looks a few messages back on each side.
  it("catches a point already made a few messages ago, not just in the last one", () => {
    const said = "The migration ran on staging, the row counts match, and I archived the old table.";
    const looping = roomWith([
      { from: "a", text: said },
      { from: "b", text: "Understood, I will note that for the release page." },
      { from: "a", text: "The release page lives in the shared drive under releases." },
      { from: "b", text: "Noted, thanks for the pointer to the shared drive." },
    ]);
    const reworded = "The migration ran on staging, row counts match, and I have archived that old table.";
    expect(isAcknowledgement(looping, "a", reworded)).toBe(true);
    // ...and genuinely new information still travels
    expect(isAcknowledgement(looping, "a", "The nightly index rebuild is still queued and nobody owns it.")).toBe(false);
  });

  it("is false for an empty message - there is nothing to record", () => {
    expect(isAcknowledgement(room, "a", "   ")).toBe(false);
  });
});

// A conversation cut off by a restart is a turn that never started, not a
// failure: the status and the pending recipient both survive, so the harness
// can hand the message over again.
describe("RoomStore: surviving a restart mid-conversation", () => {
  it("keeps a running room running, remembers who owed a turn, and lists it as recovered", () => {
    const dir = mkdtempSync(join(tmpdir(), "multibot-rooms-resume-"));
    const file = join(dir, "rooms.json");
    try {
      const first = new RoomStore(file);
      const room = first.create({ task: "ship it", bot_ids: ["a", "b"], ownerThread: "t", ownerBotId: "a" });
      first.append(room.id, "a", "ship it");
      first.setPending(room.id, "b");

      const reopened = new RoomStore(file);
      expect(reopened.get(room.id)).toMatchObject({ status: "running", pendingTo: "b" });
      expect(reopened.recovered).toEqual([room.id]);

      // ...and the turn starting clears the debt, so a LATER restart does not
      // deliver the same message a second time.
      reopened.setPending(room.id, null);
      expect(new RoomStore(file).get(room.id)?.pendingTo).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
