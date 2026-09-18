import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MAX_PARALLEL_TURNS, TurnGate, maxParallelTurns } from "./turn-gate.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  delete process.env.MULTIBOT_MAX_PARALLEL_TURNS;
});

describe("maxParallelTurns", () => {
  it("bez zmiennej daje domyślne cztery", () => {
    expect(maxParallelTurns()).toBe(DEFAULT_MAX_PARALLEL_TURNS);
  });

  it("czyta MULTIBOT_MAX_PARALLEL_TURNS i odrzuca śmieci", () => {
    process.env.MULTIBOT_MAX_PARALLEL_TURNS = "2";
    expect(maxParallelTurns()).toBe(2);
    process.env.MULTIBOT_MAX_PARALLEL_TURNS = "0";
    expect(maxParallelTurns()).toBe(DEFAULT_MAX_PARALLEL_TURNS);
    process.env.MULTIBOT_MAX_PARALLEL_TURNS = "nonsense";
    expect(maxParallelTurns()).toBe(DEFAULT_MAX_PARALLEL_TURNS);
  });
});

describe("TurnGate", () => {
  it("różne boty wchodzą RÓWNOLEGLE, nie jeden po drugim", async () => {
    const gate = new TurnGate();
    const started: string[] = [];
    await Promise.all(
      ["a", "b", "c", "d"].map((id) => gate.acquire(id).then(() => started.push(id))),
    );
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(gate.state().waiting).toEqual([]);
  });

  it("ponad sufit czeka w FIFO i rusza po zwolnieniu slotu", async () => {
    process.env.MULTIBOT_MAX_PARALLEL_TURNS = "2";
    const gate = new TurnGate();
    await gate.acquire("a");
    await gate.acquire("b");
    let cStarted = false;
    const c = gate.acquire("c").then(() => (cStarted = true));
    await tick();
    expect(cStarted).toBe(false);
    expect(gate.state()).toEqual({ active: ["a", "b"], waiting: ["c"] });
    gate.release("a");
    await c;
    expect(cStarted).toBe(true);
    expect(gate.state().active).toEqual(["b", "c"]);
  });

  it("ten sam bot nie bierze drugiego slotu (tura zagnieżdżona)", async () => {
    process.env.MULTIBOT_MAX_PARALLEL_TURNS = "1";
    const gate = new TurnGate();
    await gate.acquire("a");
    await gate.acquire("a"); // nie zawiesza się na sobie
    expect(gate.state()).toEqual({ active: ["a"], waiting: [] });
  });

  it("zwolnienie klucza bez slotu jest bezpieczne, także z kolejki", async () => {
    process.env.MULTIBOT_MAX_PARALLEL_TURNS = "1";
    const gate = new TurnGate();
    await gate.acquire("a");
    void gate.acquire("b");
    gate.release("b"); // tura padła zanim dostała slot
    expect(gate.state()).toEqual({ active: ["a"], waiting: [] });
    gate.release("ghost");
    gate.release("a");
    expect(gate.state()).toEqual({ active: [], waiting: [] });
  });

  it("reset budzi wszystkich czekających", async () => {
    process.env.MULTIBOT_MAX_PARALLEL_TURNS = "1";
    const gate = new TurnGate();
    await gate.acquire("a");
    let woken = false;
    const b = gate.acquire("b").then(() => (woken = true));
    gate.reset();
    await b;
    expect(woken).toBe(true);
    expect(gate.state()).toEqual({ active: [], waiting: [] });
  });
});
