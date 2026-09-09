import { describe, expect, it } from "vitest";

import type { Bot, Room } from "@/state/store";
import {
  PEER_CHAT_WAVE_MS,
  WAVE_VARIANT_COUNT,
  bubbleWaves,
  isEngagedInPeerChat,
  selectActivePeerChat,
  waveSeed,
} from "./botChatAnimation";

// Pomocnicze fabryki: minimalny poprawny kształt danych ze store'a, żeby test
// mówił o zasadzie wyboru, a nie o budowie rekordów z API.
function bot(id: string, over: Partial<Bot> = {}): Bot {
  return {
    id,
    threadId: `thread-${id}`,
    name: `Bot-${id}`,
    title: "",
    description: "",
    notifications: false,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "inst", model: "test-model" },
    messages: [],
    ...over,
  };
}

function room(id: string, botIds: string[], status: Room["status"] = "running", activeBotId?: string | null): Room {
  return {
    id,
    name: id,
    task: "task",
    bot_ids: botIds,
    transcript: [],
    status,
    createdAt: 0,
    ownerBotId: botIds[0] ?? "",
    ...(activeBotId !== undefined ? { activeBotId } : {}),
  };
}

describe("isEngagedInPeerChat", () => {
  const a = bot("a");
  const idle = bot("b");
  const working = bot("b", { busy: true });

  it("kolega wlasnie pisze -> wymiana trwa", () => {
    expect(isEngagedInPeerChat([room("r1", ["a", "b"])], "a", { a, b: working })).toBe(true);
  });

  it("szczelina miedzy turami: dlug `pendingTo` liczy sie tak samo", () => {
    const handover = { ...room("r1", ["a", "b"]), pendingTo: "b" };
    expect(isEngagedInPeerChat([handover], "a", { a, b: idle })).toBe(true);
  });

  it("cisza w pokoju to nie wymiana", () => {
    expect(isEngagedInPeerChat([room("r1", ["a", "b"])], "a", { a, b: idle })).toBe(false);
  });

  it("wlasne `busy` nie jest rozmowa z nikim", () => {
    const solo = bot("a", { busy: true });
    expect(isEngagedInPeerChat([room("r1", ["a", "b"])], "a", { a: solo, b: idle })).toBe(false);
  });

  it("pokoj grupy to czat czlowieka, nie rozmowa botow", () => {
    const group = { ...room("r1", ["a", "b"]), groupId: "g1" };
    expect(isEngagedInPeerChat([group], "a", { a, b: working })).toBe(false);
  });

  it("zamkniety pokoj i pokoj bez tego bota nie licza sie", () => {
    expect(isEngagedInPeerChat([room("r1", ["a", "b"], "done")], "a", { a, b: working })).toBe(false);
    expect(isEngagedInPeerChat([room("r1", ["c", "b"])], "a", { a, b: working })).toBe(false);
  });
});

describe("selectActivePeerChat", () => {
  it("zwraca null, gdy nie ma żadnych pokoi", () => {
    const bots = { a: bot("a"), b: bot("b") };
    expect(selectActivePeerChat([], "a", bots)).toBeNull();
  });

  it("znajduje partnera z aktywnego pokoju, w którym siedzi oglądany bot", () => {
    const a = bot("a");
    const b = bot("b", { color: "pink" });
    const result = selectActivePeerChat([room("r1", ["a", "b"])], "a", { a, b });
    expect(result).not.toBeNull();
    expect(result?.roomId).toBe("r1");
    expect(result?.peerBot.id).toBe("b");
  });

  it("passes the current speaker from the room", () => {
    const a = bot("a");
    const b = bot("b");
    const result = selectActivePeerChat([room("r1", ["a", "b"], "running", "b")], "a", { a, b });
    expect(result?.activeBotId).toBe("b");
  });

  it("ignoruje pokoje zakończone — status inny niż running", () => {
    const bots = { a: bot("a"), b: bot("b") };
    expect(selectActivePeerChat([room("r1", ["a", "b"], "done")], "a", bots)).toBeNull();
    expect(selectActivePeerChat([room("r1", ["a", "b"], "failed")], "a", bots)).toBeNull();
  });

  it("zwraca null, gdy oglądany bot nie uczestniczy w pokoju", () => {
    const bots = { a: bot("a"), b: bot("b"), c: bot("c") };
    expect(selectActivePeerChat([room("r1", ["b", "c"])], "a", bots)).toBeNull();
  });

  it("przy kilku aktywnych pokojach wybiera pierwszego aktywnego partnera z listy", () => {
    const bots = { a: bot("a"), b: bot("b"), c: bot("c") };
    const rooms = [room("r-old", ["a", "b"]), room("r-new", ["a", "c"])];
    const result = selectActivePeerChat(rooms, "a", bots);
    expect(result?.roomId).toBe("r-old");
    expect(result?.peerBot.id).toBe("b");
  });

  it("pomija uczestnika, którego nie ma w mapie botów (usunięty), i ukrytego", () => {
    const a = bot("a");
    const c = bot("c");
    // b istnieje w pokoju, ale zniknął ze store'a; d jest ukryty
    const rooms = [room("r1", ["a", "b", "c", "d"])];
    expect(selectActivePeerChat(rooms, "a", { a, c })).not.toBeNull();
    const hidden = { a, c: bot("c", { hidden: true }) };
    expect(selectActivePeerChat(rooms, "a", hidden)).toBeNull();
  });

  it("pojedynczy bot w pokoju bez innych uczestników daje null", () => {
    const bots = { a: bot("a") };
    expect(selectActivePeerChat([room("r1", ["a"])], "a", bots)).toBeNull();
  });
});

describe("bubbleWaves", () => {
  const seed = waveSeed("room-17");

  it("rytm wymiany szlaczków trzyma ~15 sekund", () => {
    expect(PEER_CHAT_WAVE_MS).toBe(15_000);
  });

  it("w tej samej chwili oba dymki mają inną kombinację fal", () => {
    const owner = bubbleWaves(seed, 0, 0);
    const peer = bubbleWaves(seed, 1, 0);
    expect(owner.join("|")).not.toBe(peer.join("|"));
  });

  it("po tiknięciu szlaczki się zmieniają — w obu dymkach", () => {
    for (const slot of [0, 1]) {
      expect(bubbleWaves(seed, slot, 0)).not.toEqual(bubbleWaves(seed, slot, 1));
      expect(bubbleWaves(seed, slot, 1)).not.toEqual(bubbleWaves(seed, slot, 2));
    }
  });

  it("jest deterministyczne: te same dane wejściowe, te same ścieżki", () => {
    expect(bubbleWaves(seed, 0, 3)).toEqual(bubbleWaves(seed, 0, 3));
    expect(waveSeed("room-17")).toBe(waveSeed("room-17"));
    expect(waveSeed("room-18")).not.toBe(waveSeed("room-17"));
  });

  it("różne pokoje startują z różnymi kombinacjami", () => {
    const first = bubbleWaves(waveSeed("room-a"), 0, 0).join("|");
    const second = bubbleWaves(waveSeed("room-b"), 0, 0).join("|");
    expect(first).not.toBe(second);
  });

  it("każdy wariant z puli jest kiedyś używany — górna i dolna linia osobno", () => {
    const used = new Set<string>();
    for (let tick = 0; tick < 40; tick++) {
      for (let slot = 0; slot < 2; slot++) {
        for (const path of bubbleWaves(seed, slot, tick)) used.add(path);
      }
    }
    // 6 kształtów × 2 linie w dymku: pełna pula przechodzi w kółko
    expect(used.size).toBe(2 * WAVE_VARIANT_COUNT);
  });

  it("ścieżki są poziomymi krzywymi mieszczącymi się w pudełku 48×18", () => {
    for (let tick = 0; tick < WAVE_VARIANT_COUNT * 2; tick++) {
      for (const path of bubbleWaves(seed, tick % 2, tick)) {
        expect(path).toMatch(/^[MLCQSTZmlcqstz\s\d.,-]+$/);
        const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        expect(numbers.length % 2).toBe(0);
        for (let i = 0; i < numbers.length; i += 2) {
          expect(numbers[i]).toBeGreaterThanOrEqual(0);
          expect(numbers[i]).toBeLessThanOrEqual(48);
          expect(numbers[i + 1]).toBeGreaterThanOrEqual(0);
          expect(numbers[i + 1]).toBeLessThanOrEqual(18);
        }
      }
    }
  });
});
