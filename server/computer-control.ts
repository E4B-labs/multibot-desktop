// multibot (H5): who may type on the computer.
//
// There is one computer for the whole installation, so there is one input
// owner. Agents own input by default; the user can take it and hand it back.
// Seeing the screen is never gated — the point of the shared desktop is that
// everyone watches the same thing, so only input is leased.
//
// The lease is short and renewed while the user is active, so a closed laptop
// lid cannot hold the computer hostage. State is in memory on purpose: after a
// harness restart the correct owner is the agent, which is what "no lease"
// already means.
//
// The agent side is NOT a mutex. It used to be: a turn took an exclusive lease
// for its whole length, so a second bot could not start until the first one
// finished and the fleet looked serial even when nothing touched the desktop.
// No computer tool ever checked the lease, so the exclusivity bought nothing
// and cost every parallel turn. Running turns are now admitted (and only
// capped) by the shared TurnGate — see server/turn-gate.ts.
import { turnGate } from "./turn-gate.ts";

/** Long enough to survive a slow render or a brief network hiccup, short enough
 *  that an abandoned tab frees the computer quickly. */
export const LEASE_MS = 30_000;

export type ControlOwner = "agent" | "user";

export interface Control {
  owner: ControlOwner;
  /** epoch ms; only meaningful while `owner === "user"` */
  expiresAt?: number;
  /** A bot with a turn running on the computer right now. */
  agentOwner?: string;
  /** Bots whose turn waits for a free slot, in FIFO order. */
  agentQueue?: string[];
  /** Bots DRIVING the computer right now — see `setAgentActing`. */
  agentActing?: string[];
}

let leaseExpiresAt: number | null = null;

/**
 * Bots that actually reached for the computer during the turn running now (a
 * `mcp__computer__*` tool started). This is the third level of visibility —
 * Status: the chat header says the machine is being used without the user
 * opening the preview or taking over. Holding a turn-gate slot is NOT this;
 * most turns never touch the desktop.
 *
 * In memory like the lease, and for the same reason: after a restart no turn is
 * running, so an empty set is the correct answer.
 */
const acting = new Set<string>();

/** Mark (or unmark) a bot as driving the computer. Returns whether anything
 *  changed, so the caller broadcasts once per real transition instead of once
 *  per tool call of the same turn. */
export function setAgentActing(botId: string, on: boolean): boolean {
  if (!on) return acting.delete(botId);
  if (acting.has(botId)) return false;
  acting.add(botId);
  return true;
}

function agentState() {
  const { active, waiting } = turnGate.state();
  return {
    ...(active.length ? { agentOwner: active[0] } : {}),
    ...(waiting.length ? { agentQueue: waiting } : {}),
    ...(acting.size ? { agentActing: [...acting] } : {}),
  };
}

export function control(now = Date.now()): Control {
  if (leaseExpiresAt === null || leaseExpiresAt <= now) {
    leaseExpiresAt = null;
    return { owner: "agent", ...agentState() };
  }
  return { owner: "user", expiresAt: leaseExpiresAt, ...agentState() };
}

/** Take or extend the user's lease. Idempotent — re-acquiring a live lease is a
 *  renewal, not a conflict.
 *
 *  Kształt odpowiedzi to pełne `control()`, razem ze stanem agentów: człowiek
 *  z klawiaturą nadal ma widzieć, że bot pracuje. Panel odnawia dzierżawę
 *  w pętli, więc gołe `{owner, expiresAt}` czyściło mu ten widok co kilka sekund. */
export function acquire(now = Date.now()): Control {
  leaseExpiresAt = now + LEASE_MS;
  return control(now);
}

export const renew = acquire;

export function release(): Control {
  leaseExpiresAt = null;
  return control();
}

/** Admit this bot's turn. Resolves at once while the fleet is under
 *  MULTIBOT_MAX_PARALLEL_TURNS — other bots are never waited for one by one. */
export function acquireAgent(botId: string): Promise<void> {
  return turnGate.acquire(botId);
}

/** End this bot's turn and let the next waiting one in. Safe for a bot that
 *  never took a slot. */
export function releaseAgent(botId: string): Control {
  turnGate.release(botId);
  return control();
}

/** Test/reset hook; no live turn can survive a harness restart. */
export function resetAgentQueue(): void {
  turnGate.reset();
  acting.clear();
}

/**
 * Whether an agent tool call may act right now.
 *
 * Screenshots stay allowed while the user drives — the agent has to keep
 * watching to continue sensibly afterwards. Input is refused with a named
 * state, never a random tool error, so the model can say "waiting for you"
 * instead of inventing a failure.
 */
export function agentMayAct(kind: "read" | "input", now = Date.now()): true | "user_has_control" {
  if (kind === "read") return true;
  return control(now).owner === "agent" ? true : "user_has_control";
}
