// multibot (H2): the parts of the computer that are decidable without a daemon.
// The container lifecycle itself is covered by the H0 spike against a real
// image, not here.
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKEND,
  IDLE_MS,
  CONTAINER_NAME,
  CONTAINER_PORTS,
  VOLUME_NAME,
  computersDisabled,
  dockerCommand,
  ensureComputer,
  parsePortOutput,
  rememberReadyPorts,
  _idleForTests,
  computerIdleStatus,
  holdComputer,
  releaseComputerHold,
  touchComputer,
} from "./hosted-computer.ts";

describe("naming", () => {
  // One computer per installation: the names are constants, never derived from
  // a bot, so every bot resolves to the same container and volume.
  it("is fixed, not per bot", () => {
    expect(CONTAINER_NAME).toBe("multibot-computer");
    expect(VOLUME_NAME).toBe("multibot-computer-data");
  });
});

describe("dockerCommand", () => {
  it("tunnels through WSL on Windows — there is no native daemon there", () => {
    const { file, args } = dockerCommand(["ps"], "win32");
    expect(file).toBe("wsl");
    expect(args.slice(0, 2)).toEqual(["-d", "Ubuntu"]);
    expect(args.slice(-2)).toEqual(["docker", "ps"]);
  });

  it("calls docker directly elsewhere", () => {
    expect(dockerCommand(["ps"], "linux")).toEqual({ file: "docker", args: ["ps"] });
  });
});

describe("parsePortOutput", () => {
  it("reads the loopback binding", () => {
    expect(parsePortOutput("127.0.0.1:32773")).toBe(32773);
  });

  it("handles IPv6 loopback, where the last colon is the separator", () => {
    expect(parsePortOutput("[::1]:32780")).toBe(32780);
  });

  it("picks the loopback line when docker prints several", () => {
    expect(parsePortOutput("[::1]:32781\n127.0.0.1:32780")).toBe(32781);
  });

  // The whole security story of the computer is "loopback only". A wildcard
  // binding must fail loudly rather than be used.
  it("refuses a wildcard binding instead of exposing the computer", () => {
    expect(parsePortOutput("0.0.0.0:32773")).toBeNull();
  });

  it("returns null on junk", () => {
    expect(parsePortOutput("")).toBeNull();
    expect(parsePortOutput("no colon here")).toBeNull();
  });
});

describe("ensureComputer", () => {
  it("dedupes concurrent calls so the panel's polling cannot race a turn", async () => {
    // Every bot now shares one container, so these races are more frequent.
    // Under vitest docker is refused, so this pins the sharing, not the machine.
    expect(computersDisabled()).toBe(true);
    const [a, b] = await Promise.all([ensureComputer(), ensureComputer()]);
    expect(a).toEqual(b);
    expect(a.state).toBe("error");
  });

  it("skips docker while the last known browser still answers its CDP probe", async () => {
    // Docker is refused under vitest, so a "ready" answer can only have come
    // from the probe shortcut — the ~10 s of `wsl docker …` per turn on Windows.
    const cdp = createServer((_req, res) => res.end("{}"));
    await new Promise<void>((resolve) => cdp.listen(0, "127.0.0.1", resolve));
    const port = (cdp.address() as { port: number }).port;
    try {
      rememberReadyPorts({ cdp: port, novnc: port, api: port });
      expect((await ensureComputer()).state).toBe("ready");
      cdp.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Browser gone → back to the real path, which is refused here.
      expect((await ensureComputer()).state).toBe("error");
    } finally {
      rememberReadyPorts(null);
      cdp.close();
    }
  });
});

describe("ports", () => {
  it("publishes exactly the three the image serves", () => {
    expect(CONTAINER_PORTS).toEqual({ cdp: 9223, novnc: 6901, api: 8000 });
  });
});

describe("backend selection", () => {
  // Explicit, never inferred: falling back to an unisolated desktop just
  // because docker was missing would hand an agent a shell on the user's own
  // machine with nobody having decided that.
  it("defaults to docker", () => {
    expect(BACKEND).toBe("docker");
  });
});

// Computer on demand: the desktop sleeps after IDLE_MS without use, unless a
// turn with the computer tools mounted still holds it. Measured on the phone:
// without this the native backend kept a whole XFCE running forever.
describe("idle stop", () => {
  const stops: number[] = [];
  const idle = _idleForTests(async () => { stops.push(Date.now()); });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    stops.length = 0;
    idle.holds.clear();
    idle.running = true;
  });
  afterEach(() => {
    if (idle.timer) clearTimeout(idle.timer);
    idle.timer = null;
    idle.running = false;
    vi.useRealTimers();
  });

  it("defaults to five minutes", () => {
    expect(IDLE_MS).toBe(300_000);
    expect(computerIdleStatus()).toEqual({ running: true, idleMs: IDLE_MS });
  });

  it("stops once nothing used it for IDLE_MS", async () => {
    touchComputer();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(stops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops).toEqual([IDLE_MS]);
    expect(computerIdleStatus().running).toBe(false);
  });

  it("every use pushes the deadline back", async () => {
    touchComputer();
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    touchComputer();
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    expect(stops).toEqual([]);
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    expect(stops).toEqual([IDLE_MS * 1.5]);
  });

  it("a turn holding the computer keeps it awake until released", async () => {
    holdComputer("bot-a");
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(stops).toEqual([]);
    expect(computerIdleStatus().running).toBe(true);
    releaseComputerHold("bot-a");
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(stops).toHaveLength(1);
  });

  it("does nothing while the computer is already down", async () => {
    idle.running = false;
    touchComputer();
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(stops).toEqual([]);
  });
});
