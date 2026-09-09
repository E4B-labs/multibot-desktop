// Claude driver contract tests, run against the scripted fake CLI in
// server/testing/fake-claude-cli.ts — the driver must normalize the
// stream-json protocol into canonical events, keep argv hygiene (prompt
// over stdin, secrets stripped), and broker permission asks.
//
// multibot: these used to be POSIX-only — the fake CLI is a shebang
// script Windows cannot exec, and the broker is a unix socket. Both now
// go through resolveCliSpawn / permissionSocketPath, so they run
// everywhere.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeConnector, saveConnector } from "../mcp-connectors.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver, permissionSocketPath } from "./claude.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

describe("ClaudeDriver.decodeConfig", () => {
  it("defaults to the claude binary with acceptEdits", () => {
    expect(ClaudeDriver.decodeConfig({})).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
    expect(ClaudeDriver.decodeConfig(undefined)).toEqual({ cli: "claude", permissionMode: "acceptEdits" });
  });

  it("accepts the three known permission modes", () => {
    for (const permissionMode of ["acceptEdits", "auto", "bypassPermissions"] as const) {
      expect(ClaudeDriver.decodeConfig({ permissionMode }).permissionMode).toBe(permissionMode);
    }
  });

  it("throws on an invalid permissionMode (registry downgrades this to a shadow)", () => {
    expect(() => ClaudeDriver.decodeConfig({ permissionMode: "yolo" })).toThrow(/permissionMode/);
  });
});

describe("ClaudeDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (mode?: string) => {
    if (mode) process.env.FAKE_CLAUDE_MODE = mode;
    instance = await ClaudeDriver.create({
      instanceId: "claude-test",
      displayName: "Claude Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "multibot-claude-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_DUMP;
    delete process.env.FAKE_CLAUDE_DEAF_FLAG;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MULTIBOT_FIRST_EVENT_MS;
    delete process.env.MULTIBOT_FIRST_EVENT_COLD_MS;
    delete process.env.MULTIBOT_WARM_WORKERS;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant_text
      "item.started", // tool tu-1
      "thread.token-usage.updated",
      "item.completed", // tool tu-1 result
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "claudeAgent")).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 12, output: 5 }); // input + cache_read
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true, cost: 0.01 });
    // Workers stay warm after a completed turn; process-exiting fakes are
    // removed on the following close event.
    expect(instance.adapter.hasSession("t-happy")).toBe(true);
  });

  it("passes canonical model IDs to Claude Code", async () => {
    await create();
    const dump = join(scratch, "legacy-model.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-legacy-model", text: "hi", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
  });

  it("forwards selected reasoning effort to Claude Code", async () => {
    await create();
    const dump = join(scratch, "reasoning.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-reasoning",
      text: "hi",
      model: "claude-opus-5",
      reasoning: "max",
    } as any);
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe("max");
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("claude-opus-5");
  });

  it("streams partial-message text deltas without re-emitting the whole message", async () => {
    await create("stream");
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    const text = deltas.filter((d: any) => d.streamKind === "assistant_text");
    // two streamed chunks, and NO third full-text fallback delta after them
    expect(text.map((d: any) => d.delta)).toEqual(["hello from ", "fake claude"]);
    // subagent narration (parent_tool_use_id) never surfaces
    expect(text.some((d: any) => d.delta.includes("SUBAGENT"))).toBe(false);
    // reasoning streams on its own kind
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "hmm")).toBe(true);
    // the settled message still lands exactly once
    const settled = recorder.events.filter((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("hello from fake claude");
  });

  it("sends the prompt over stdin, never argv, and strips identity env vars", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.ANTHROPIC_API_KEY = "placeholder-key-not-forwarded";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "the secret prompt", system: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(JSON.stringify(seen.argv)).not.toContain("the secret prompt");
    expect(seen.prompt).toMatchObject({ type: "user", message: { role: "user", content: "the secret prompt" } });
    expect(seen.argv).toContain("--append-system-prompt");
    expect(seen.argv).toContain("--session-id");
    // Regresja: wbudowane `AskUserQuestion` działa tylko w trybie
    // interaktywnym. Model je wołał, nie dostawał nic i pisał „brak
    // odpowiedzi" — pytanie nigdy nie trafiało do czatu. Musi być odcięte,
    // żeby model sięgnął po `mcp__agents__ask_user`.
    expect(seen.argv[seen.argv.indexOf("--disallowedTools") + 1]).toContain("AskUserQuestion");
    expect(seen.argv).toContain("--effort");
    expect(seen.argv[seen.argv.indexOf("--effort") + 1]).toBe("low");
    expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.CLAUDECODE).toBeUndefined();
    expect(seen.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it("mounts the agents comms proxy as an MCP server and pre-allows its tools", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "hi",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { MULTIBOT_HARNESS_URL: "http://127.0.0.1:1", MULTIBOT_BOT_ID: "b1", MULTIBOT_COMMS_TOKEN: "tok", MULTIBOT_TURN_DEPTH: "0" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const mcpConfig = JSON.parse(seen.argv[seen.argv.indexOf("--mcp-config") + 1]);
    expect(mcpConfig.mcpServers.agents).toMatchObject({
      args: ["/fake/agents-proxy.js"],
      env: { MULTIBOT_BOT_ID: "b1", MULTIBOT_COMMS_TOKEN: "tok" },
    });
    const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("mcp__agents");
    // multibot: bot dostaje tylko nasze serwery — nigdy globalnej konfiguracji
    // MCP właściciela maszyny (prywatne konektory claude.ai).
    expect(seen.argv).toContain("--strict-mcp-config");
  });

  // multibot (F7): własne serwery MCP użytkownika jadą tą samą drogą co
  // Composio — wspólnym helperem `server/mcp-servers.ts`.
  it("mounts the user's own MCP connectors next to Composio and pre-allows them", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    saveConnector("echo", {
      name: "Echo",
      transport: { type: "stdio", command: process.execPath, args: ["/fake/echo-mcp.js"], env: { TOKEN: "t" } },
    });
    try {
      await instance.adapter.sendTurn({
        threadId: "t-custom-mcp",
        text: "hi",
        integrations: { composio: { key: "ck_test" } },
      });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const mcpConfig = JSON.parse(seen.argv[seen.argv.indexOf("--mcp-config") + 1]);
      // Composio bez najmniejszej zmiany zachowania…
      expect(mcpConfig.mcpServers.composio).toEqual({
        type: "http",
        url: "https://connect.composio.dev/mcp",
        headers: { "x-consumer-api-key": "ck_test" },
      });
      // …a obok niego konektor użytkownika, ze swoim sekretem w env
      expect(mcpConfig.mcpServers.echo).toEqual({
        command: process.execPath,
        args: ["/fake/echo-mcp.js"],
        env: { TOKEN: "t" },
      });
      const allowed = seen.argv[seen.argv.indexOf("--allowedTools") + 1].split(",");
      expect(allowed).toEqual(expect.arrayContaining(["mcp__composio", "mcp__echo"]));
    } finally {
      removeConnector("echo");
    }
  });

  it("resumes with --resume when a cursor exists and reports that session id", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "sess-123" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "sess-123" });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--resume");
    expect(seen.argv).not.toContain("--session-id");
  });

  // multibot: sesja bez kursora nie zna rozmowy — harness dokłada ją z dysku.
  it("replays the stored thread history into a session started without --resume", async () => {
    await create();
    const dump = join(scratch, "replay.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-replay",
      text: "what is my dog called?",
      transcript: [
        { role: "user", text: "my dog is called Bruno" },
        { role: "assistant", text: "noted, Bruno it is" },
      ],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("--session-id");
    expect(seen.prompt.message.content).toContain("User: my dog is called Bruno");
    expect(seen.prompt.message.content).toContain("You: noted, Bruno it is");
    expect(seen.prompt.message.content).toContain("what is my dog called?");
  });

  it("rejects a second turn while one is in flight", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    expect(instance.adapter.hasSession("t-busy")).toBe(true);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("sends attached images as native Claude image blocks", async () => {
    await create("happy");
    const dump = join(scratch, "image.json");
    const image = join(scratch, "photo.png");
    writeFileSync(image, "png");
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-image",
      text: "inspect",
      attachments: [{ id: "a", name: "photo.png", mime: "image/png", size: 3, path: image }],
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).prompt.message.content).toEqual([
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "cG5n" } },
    ]);
  });

  it("keeps one Claude worker alive for the next turn", async () => {
    await create("persistent");
    await instance.adapter.sendTurn({ threadId: "t-persistent", text: "one" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(instance.adapter.hasSession("t-persistent")).toBe(true);

    await instance.adapter.sendTurn({ threadId: "t-persistent", text: "two" });
    const done = await recorder.until(
      (e) => e.type === "turn.completed" && recorder.events.filter((x) => x.type === "turn.completed").length === 2,
    );
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.filter((e) => e.type === "session.started")).toHaveLength(1);
  });

  // multibot: prompt systemowy niesie pamięć bota, a szedł do CLI tylko przy
  // spawnie — więc siedział w podpisie workera i KAŻDY zapis do pamięci kasował
  // ciepłą sesję. Zimny start to 83 s na telefonie wobec 1.7 s na ciepłej, więc
  // bot z pamięcią płacił go co turę. Teraz proces zostaje, a nowy kontekst
  // dojeżdża tą turą.
  it("a memory write keeps the worker and ships the new context with the turn", async () => {
    await create("persistent");
    const dump = join(scratch, "context.json");
    process.env.FAKE_CLAUDE_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-context", text: "one", system: "Memory facts:\n- alpha" });
    await recorder.until((e) => e.type === "turn.completed");

    await instance.adapter.sendTurn({
      threadId: "t-context", text: "two", system: "Memory facts:\n- alpha\n- beta",
    });
    await recorder.until(
      (e) => e.type === "turn.completed" && recorder.events.filter((x) => x.type === "turn.completed").length === 2,
    );

    // jeden proces na obie tury — zmiana pamięci nie zapłaciła zimnym startem
    expect(recorder.events.filter((e) => e.type === "session.started")).toHaveLength(1);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.prompt.message.content).toContain("- beta");
    expect(seen.prompt.message.content).toContain("two");
  });

  // multibot: godzina ciepłego procesu razy liczba wątków zjadłaby telefon,
  // więc żywych workerów jest najwyżej MAX_WARM_WORKERS (domyślnie 2).
  it("keeps only the most recent warm workers", async () => {
    await create("persistent");
    for (const [i, threadId] of ["t-lru-1", "t-lru-2", "t-lru-3"].entries()) {
      await instance.adapter.sendTurn({ threadId, text: `msg ${i}` });
      await recorder.until(
        (e) => e.type === "turn.completed" && recorder.events.filter((x) => x.type === "turn.completed").length === i + 1,
      );
    }

    expect(instance.adapter.hasSession("t-lru-1")).toBe(false);
    expect(instance.adapter.hasSession("t-lru-2")).toBe(true);
    expect(instance.adapter.hasSession("t-lru-3")).toBe(true);
  });

  // multibot: „każdy bot to ciepły worker" — przy MULTIBOT_WARM_WORKERS=0 nikt
  // nie wylatuje z LRU, bo każdy bot ma odpowiadać w kilka sekund, a nie tylko
  // ten, z którym rozmawiało się ostatnio.
  it("keeps every worker warm when the limit is 0", async () => {
    process.env.MULTIBOT_WARM_WORKERS = "0";
    await create("persistent");
    for (const [i, threadId] of ["t-all-1", "t-all-2", "t-all-3"].entries()) {
      await instance.adapter.sendTurn({ threadId, text: `msg ${i}` });
      await recorder.until(
        (e) => e.type === "turn.completed" && recorder.events.filter((x) => x.type === "turn.completed").length === i + 1,
      );
    }

    expect(instance.adapter.hasSession("t-all-1")).toBe(true);
    expect(instance.adapter.hasSession("t-all-2")).toBe(true);
    expect(instance.adapter.hasSession("t-all-3")).toBe(true);
  });

  it("interrupt cancels the turn without a runtime error", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create("exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error.message).toContain("simulated crash");
  });

  it("skips malformed protocol lines without losing the turn", async () => {
    await create("malformed");
    await instance.adapter.sendTurn({ threadId: "t-noise", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a missing binary surfaces as spawn_error, and snapshot says unavailable", async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "spawn_error" });

    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("brokers a permission ask into request.opened and answers over the socket", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-abc", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    // connect as the MCP proxy would and raise an ask — unix socket on
    // POSIX, named pipe on Windows, same one the driver handed the proxy
    const conn = connect(permissionSocketPath("t-perm-abc"));
    const answered = new Promise<{ behavior: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-1", tool: "Bash", input: { command: "rm -rf scratch" } }) + "\n");

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "Bash",
      summary: "rm -rf scratch",
      requestId: "ask-1",
    });

    await instance.adapter.respondToRequest("t-perm-abc", "ask-1", { behavior: "allow" });
    expect(await answered).toMatchObject({ behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    conn.end();
    await instance.adapter.interruptTurn("t-perm-abc");
    await recorder.until((e) => e.type === "turn.completed");
  });

  // Regresja: krzyżyk na karcie wysyła "deny", a pytanie przyjmowało wyłącznie
  // "answer" — odpowiedź wypadała na `false`, ask zostawał w `pending`, karta
  // znikała z czatu i bot wisiał do 15-minutowego timeoutu.
  it("closes a question when the user dismisses the card", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-ask-q", text: "go" });
    await recorder.until((e) => e.type === "session.started");

    const conn = connect(permissionSocketPath("t-ask-q"));
    const answered = new Promise<{ behavior: string; message?: string }>((resolve) => {
      let buf = "";
      conn.on("data", (c) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    conn.write(JSON.stringify({ t: "ask", id: "ask-q", kind: "question", question: "Which database?" }) + "\n");

    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question", requestId: "ask-q" });

    await instance.adapter.respondToRequest("t-ask-q", "ask-q", { behavior: "deny", message: "Dismissed by user." });
    expect(await answered).toMatchObject({ behavior: "answer", message: "Dismissed by user." });

    conn.end();
    await instance.adapter.interruptTurn("t-ask-q");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("rejects answers to unknown or already-resolved asks", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-perm-2", text: "go" });
    await expect(
      instance.adapter.respondToRequest("t-perm-2", "never-asked", { behavior: "allow" }),
    ).rejects.toThrow(/pending request/);
    await instance.adapter.interruptTurn("t-perm-2");
    await recorder.until((e) => e.type === "turn.completed");
  });
});

// multibot (B): kontrola żywotności patrzyła na `child.stdin.destroyed`, a
// `child` to proces PROOTA — zaobserwowano „proot żyje, claude w środku
// martwy". Tura szła wtedy do rury, której nikt nie czyta, i wisiała bez końca.
// Driver pilnuje więc PIERWSZEGO znaku życia na stdout: budżet dotyczy tylko
// pierwszego bajtu, długie tury zostają nietknięte.
describe("ClaudeDriver worker liveness (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (mode: string) => {
    process.env.FAKE_CLAUDE_MODE = mode;
    instance = await ClaudeDriver.create({
      instanceId: "claude-liveness",
      displayName: "Claude Liveness",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "multibot-claude-live-"));
    process.env.MULTIBOT_FIRST_EVENT_MS = "300";
    process.env.MULTIBOT_FIRST_EVENT_COLD_MS = "300";
  });

  afterEach(async () => {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_DEAF_FLAG;
    delete process.env.MULTIBOT_FIRST_EVENT_MS;
    delete process.env.MULTIBOT_FIRST_EVENT_COLD_MS;
    delete process.env.MULTIBOT_WARM_WORKERS;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("kills a silent worker, respawns it and replays the turn once", async () => {
    process.env.FAKE_CLAUDE_DEAF_FLAG = join(scratch, "deaf.flag");
    await create("deaf-once");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-deaf-once", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    // Ta sama tura, nie nowa: użytkownik nie widzi ani błędu, ani drugiej bańki.
    expect(done).toMatchObject({ type: "turn.completed", ok: true, turnId });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  });

  it("gives up after one restart and says the worker is dead", async () => {
    await create("deaf");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-deaf", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed", ok: false, stopReason: "worker_unresponsive", turnId });
    expect(
      recorder.events.some((e) => e.type === "runtime.error" && /sign of life/.test((e as any).message)),
    ).toBe(true);
  });

  // multibot (A2): rozgrzewka stawia proces i NIC więcej — żadnej tury, żadnych
  // zdarzeń. Inaczej UI dostałby turę-widmo, a prawdziwa odbiłaby się o
  // „a turn is already running".
  it("warm spawn leaves a live worker and emits nothing", async () => {
    await create("persistent");
    await instance.adapter.sendTurn({ threadId: "t-warm", text: "", warmOnly: true } as never);
    expect(instance.adapter.hasSession("t-warm")).toBe(true);
    expect(recorder.events).toHaveLength(0);

    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-warm", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed", ok: true, turnId });
  });
});
