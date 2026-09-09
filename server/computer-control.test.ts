// multibot (H5): the takeover lease. One computer for the whole installation
// means one input owner, so the lease is global. Time is injected so the expiry
// path is tested for real rather than slept through.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LEASE_MS, acquire, acquireAgent, agentMayAct, control, release, releaseAgent, resetAgentQueue } from "./computer-control.ts";

beforeEach(() => { release(); resetAgentQueue(); });

describe("control lease", () => {
  it("gives agents input by default", () => {
    expect(control()).toEqual({ owner: "agent" });
  });

  it("hands input to the user on acquire and back on release", () => {
    const now = 1_000_000;
    expect(acquire(now).owner).toBe("user");
    expect(control(now).owner).toBe("user");
    expect(release()).toEqual({ owner: "agent" });
    expect(control(now)).toEqual({ owner: "agent" });
  });

  it("expires on its own so an abandoned tab cannot hold the computer", () => {
    const now = 2_000_000;
    acquire(now);
    expect(control(now + LEASE_MS - 1).owner).toBe("user");
    expect(control(now + LEASE_MS).owner).toBe("agent");
  });

  it("renewing while active keeps the user in control", () => {
    const now = 3_000_000;
    acquire(now);
    acquire(now + LEASE_MS - 1); // renewal
    expect(control(now + LEASE_MS + 1).owner).toBe("user");
  });

  // The lease covers the machine, not a bot: taking control from one bot's
  // panel must stop every agent from typing, because they share one desktop.
  it("is global — one taken lease blocks all agents", () => {
    const now = 4_000_000;
    acquire(now);
    expect(agentMayAct("input", now)).toBe("user_has_control");
  });
});

describe("agentMayAct", () => {
  it("always lets an agent look, even mid-takeover", () => {
    const now = 5_000_000;
    acquire(now);
    expect(agentMayAct("read", now)).toBe(true);
  });

  it("lets agents type again after hand back", () => {
    const now = 7_000_000;
    acquire(now);
    release();
    expect(agentMayAct("input", now)).toBe(true);
  });
});

describe("shared computer turn queue", () => {
  afterEach(() => { delete process.env.MULTIBOT_MAX_PARALLEL_TURNS; resetAgentQueue(); });

  it("a second bot does NOT wait for the first one to finish", async () => {
    await acquireAgent("alpha");
    let betaStarted = false;
    await acquireAgent("beta").then(() => { betaStarted = true; });
    expect(betaStarted).toBe(true);
    expect(control().agentQueue).toBeUndefined();
  });

  it("queues in FIFO order only above MULTIBOT_MAX_PARALLEL_TURNS", async () => {
    process.env.MULTIBOT_MAX_PARALLEL_TURNS = "1";
    await acquireAgent("alpha");
    let betaStarted = false;
    const beta = acquireAgent("beta").then(() => { betaStarted = true; });
    expect(betaStarted).toBe(false);
    expect(control().agentOwner).toBe("alpha");
    expect(control().agentQueue).toEqual(["beta"]);
    releaseAgent("alpha");
    await beta;
    expect(betaStarted).toBe(true);
    expect(control().agentOwner).toBe("beta");
  });
});
