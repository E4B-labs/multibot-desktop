// Codex driver contract tests, run against the scripted fake app-server
// in server/testing/fake-codex-app-server.ts — the driver must drive the
// JSON-RPC handshake, normalize notifications into canonical events, and
// surface server->client approval requests as request.opened.
//
// multibot: the fake is a shebang script — same constraint codex.cmd
// itself hits on Windows. resolveCliSpawn covers both, so these run
// everywhere now.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { AGENTS_TOOLS_VERSION } from "../turn-tools.ts";
import { COMPUTER_MCP_TOOLS } from "../turn-tools.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { clearTurnPolicy, setTurnPolicy } from "../turn-policy.ts";
import { CodexDriver, codexMcpConfig, cursorMcpKey, cursorPlan, splitCursor, COMPUTER_TOOLS_VERSION } from "./codex.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

describe("CodexDriver.decodeConfig", () => {
  it("defaults to the codex binary with fullAuto off", () => {
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig(undefined)).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
    // anything non-true is off — a truthy string must not enable full auto
    expect(CodexDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
  });
});

describe("CodexDriver turns (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (opts: { mode?: string; fullAuto?: boolean } = {}) => {
    if (opts.mode) process.env.FAKE_CODEX_MODE = opts.mode;
    instance = await CodexDriver.create({
      instanceId: "codex-test",
      displayName: "Codex Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto ?? false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_DUMP;
    delete process.env.OPENAI_API_KEY;
    for (const id of ["t-policy-deny", "t-policy-auto", "t-mcp-auto", "t-mcp-resume"]) clearTurnPolicy(id);
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("runs the handshake and normalizes a full turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OPENAI_API_KEY = "sk-should-not-leak";

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "list files",
      system: "You are Testy.",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // commandExecution ls -la
      "item.completed", // commandExecution done
      "content.delta",
      "item.completed", // assistant_text
      "thread.token-usage.updated",
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "codex")).toBe(true);
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({
      sessionId: "codex-thread-1",
      model: "fake-codex-model",
    });
    // multibot: Codex raportuje narastającą sumę — driver emituje DELTY
    // (4/2, potem 3/1), żeby recordTokens nie liczył sumy sum
    expect(recorder.events.filter((e) => e.type === "thread.token-usage.updated")).toMatchObject([
      { input: 4, output: 2 },
      { input: 3, output: 1 },
    ]);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    const methods = seen.calls.map((c: { method: string }) => c.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    // persona rides as thread instructions (when available) + as labeled SYSTEM input
    const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params.instructions).toBe("You are Testy.");
    const turnStart = seen.calls.at(-1);
    expect(turnStart.params.input[0].text).toContain("You are Testy.");
    expect(turnStart.params.input[0].text).toContain("SYSTEM — MultiBot identity");
    expect(turnStart.params.input[1].text).toBe("list files");
  });

  it("streams agentMessage deltas without re-emitting the settled text", async () => {
    process.env.FAKE_CODEX_MODE = "stream";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const text = recorder.events.filter(
      (e: any) => e.type === "content.delta" && e.streamKind === "assistant_text",
    );
    // the two streamed chunks only — no third whole-message fallback delta
    expect(text.map((d: any) => d.delta)).toEqual(["done from ", "fake codex"]);
    const settled = recorder.events.filter(
      (e: any) => e.type === "item.completed" && e.itemType === "assistant_text",
    );
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("done from fake codex");
  });

  it("tries thread/resume with a cursor and reuses the thread id", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "codex-thread-9" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-9" });
    await recorder.until((e) => e.type === "turn.completed");

    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  // multibot (0.3.32): codex 0.153 nie odtwarza piaskownicy wznawianego wątku,
  // a w piaskownicy KAŻDE narzędzie MCP chce aprobaty — przy `never` odmawia.
  // Pierwsza tura bota z pełnym dostępem działała, każda następna dostawała
  // "MCP tool call requires approval". Pilnujemy więc, że `thread/resume`
  // wiezie te same ustawienia wątku co `thread/start`.
  it("resumes a full-access thread with its sandbox so MCP tools still run", async () => {
    await create({ mode: "resume-mcp" });
    const dump = join(scratch, "resume-mcp.json");
    process.env.FAKE_CODEX_DUMP = dump;
    setTurnPolicy("t-mcp-resume", { autonomy: "autonomous", access: "full", permissions: { delegation: true, file: true } });

    await instance.adapter.sendTurn({ threadId: "t-mcp-resume", text: "list my routines", resumeCursor: "codex-thread-9" });
    const reply = await recorder.until((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect((reply as any).text).toBe("no routines");
    await recorder.until((e) => e.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{ method: string; params: any }>;
    expect(calls.find((c) => c.method === "thread/resume")!.params).toMatchObject({
      threadId: "codex-thread-9",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  // multibot: #68 przywróciło komputer bota, ale sprawdzał go tylko test na
  // samym `codexMcpConfig` — nikt nie pilnował, czy ten blok DOJEŻDŻA do
  // `thread/start`. Bot na telefonie meldował "BRAK-NARZĘDZI" przy pełnym
  // dostępie, więc cała droga (integrations → config → thread/start) ma teraz
  // własny test.
  it("carries the computer server, its whitelist and the mcp tool-visibility override into thread/start", async () => {
    await create();
    const dump = join(scratch, "computer-start.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-computer",
      text: "open example.com",
      integrations: { localComputer: { command: "node", args: ["mcp.js"], env: {} } },
    } as SendTurnInput);
    await recorder.until((e) => e.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{ method: string; params: any }>;
    const start = calls.find((c) => c.method === "thread/start")!;
    expect(start.params.config.mcp_servers.computer).toMatchObject({ command: "node", required: true });
    expect(start.params.config.mcp_servers.computer.enabled_tools).toEqual([...COMPUTER_MCP_TOOLS]);
    // Bez tego przełącznika codex 0.153 ODKŁADA narzędzia MCP i nie daje modelowi
    // niczego, czym można by je odzyskać — patrz komentarz w codex.ts.
    expect(start.params.config.features).toEqual({ tool_search_always_defer_mcp_tools: false });
  });

  it("falls back to a fresh thread when resume fails", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    await instance.adapter.sendTurn({ threadId: "t-fallback", text: "go", resumeCursor: "gone-thread" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-1" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  // multibot (0.3.31): korekta wysłana w trakcie pracy ma wejść do TEJ tury.
  // Dowód jest w zrzucie atrapy: jedno `turn/start`, po nim `turn/steer` z
  // `expectedTurnId` żywej tury — i jedno `turn.completed` na końcu.
  it("steers the running turn instead of starting a second one", async () => {
    await create({ mode: "steer" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-steer", text: "read the repo" });
    await recorder.until((e) => e.type === "item.started"); // turn/start doleciał

    expect(await instance.adapter.steerTurn!("t-steer", "actually use ripgrep")).toBe("accepted");
    await recorder.until((e) => e.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{ method: string; params: any }>;
    expect(calls.map((c) => c.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start", "turn/steer"]);
    expect(calls.at(-1)!.params).toEqual({
      threadId: "codex-thread-1",
      expectedTurnId: "codex-turn-1",
      input: [{ type: "text", text: "actually use ripgrep" }],
    });
    // jedna tura od początku do końca: jedno turn.completed, to samo turnId
    const completed = recorder.events.filter((e) => e.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: true, turnId });
    expect(recorder.events.every((e) => e.turnId === turnId)).toBe(true);
  });

  it("reports unavailable when the provider refuses to steer, and keeps the turn", async () => {
    await create({ mode: "steer-refused" }); // activeTurnNotSteerable (/review, /compact)
    await instance.adapter.sendTurn({ threadId: "t-steer-no", text: "review this" });
    await recorder.until((e) => e.type === "item.started");

    expect(await instance.adapter.steerTurn!("t-steer-no", "and also lint")).toBe("unavailable");
    // odmowa nie kończy tury — dostarczenie idzie kolejką, a tura pracuje dalej
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(instance.adapter.hasSession("t-steer-no")).toBe(true);
  });

  // Wyścig: tura kończy się w chwili, w której harness próbuje wepchnąć tekst.
  // Steering MUSI wtedy powiedzieć "unavailable" — inaczej tekst zniknąłby
  // między turą, która już nie słucha, a kolejką, do której nie trafił.
  it("reports unavailable when the turn finished first (no double delivery)", async () => {
    await create(); // happy: tura kończy się sama
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-race", text: "quick one" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(await instance.adapter.steerTurn!("t-race", "too late")).toBe("unavailable");
    // ani steeringu, ani drugiej tury — nic nie poszło do dostawcy po fakcie
    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(methods).not.toContain("turn/steer");
    expect(methods.filter((m: string) => m === "turn/start")).toHaveLength(1);
  });

  it("reports unavailable for a thread with no turn at all", async () => {
    await create();
    expect(await instance.adapter.steerTurn!("t-never-started", "hello?")).toBe("unavailable");
  });

  // multibot: "bot nie pamięta, co było wcześniej". Sesja codeksa przepada przy
  // każdym nowym wątku (aktualizacja CLI, skasowany rollout, bump
  // AGENTS_TOOLS_VERSION), a wtedy CLI startuje z pustym kontekstem. Harness ma
  // rozmowę na dysku, więc świeży wątek MUSI ją dostać w pierwszej turze.
  const earlier: SendTurnInput["transcript"] = [
    { role: "user", text: "my dog is called Bruno" },
    { role: "assistant", text: "noted, Bruno it is" },
  ];

  it("replays the stored thread history when the codex session is gone", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-replay",
      text: "what is my dog called?",
      resumeCursor: "gone-thread",
      transcript: earlier,
    });
    await recorder.until((e) => e.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls;
    const turnStart = calls.find((c: { method: string }) => c.method === "turn/start");
    const sent = turnStart.params.input.map((part: { text?: string }) => part.text ?? "").join("\n");
    expect(sent).toContain("my dog is called Bruno");
    expect(sent).toContain("noted, Bruno it is");
    expect(sent).toContain("what is my dog called?");
    // labels tell the model who said what
    expect(sent).toContain("User: my dog is called Bruno");
    expect(sent).toContain("You: noted, Bruno it is");
  });

  it("does not replay history when the codex thread resumed", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-no-replay",
      text: "and now?",
      resumeCursor: "codex-thread-9",
      transcript: earlier,
    });
    await recorder.until((e) => e.type === "turn.completed");

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls;
    const turnStart = calls.find((c: { method: string }) => c.method === "turn/start");
    const sent = turnStart.params.input.map((part: { text?: string }) => part.text ?? "").join("\n");
    expect(sent).not.toContain("my dog is called Bruno");
  });

  it("drops the oldest messages when the replay budget is exceeded", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OMB_HISTORY_MAX_CHARS = "40";
    try {
      await instance.adapter.sendTurn({
        threadId: "t-budget",
        text: "go on",
        transcript: [
          { role: "user", text: "x".repeat(200) },
          { role: "assistant", text: "the tail that still fits" },
        ],
      });
      await recorder.until((e) => e.type === "turn.completed");
    } finally {
      delete process.env.OMB_HISTORY_MAX_CHARS;
    }

    const calls = JSON.parse(readFileSync(dump, "utf8")).calls;
    const turnStart = calls.find((c: { method: string }) => c.method === "turn/start");
    const sent = turnStart.params.input.map((part: { text?: string }) => part.text ?? "").join("\n");
    expect(sent).toContain("the tail that still fits");
    expect(sent).not.toContain("x".repeat(200));
    expect(sent).toContain("1 oldest message(s) omitted");
  });

  it("surfaces an approval request and forwards the user's decision", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-approve", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "shell",
      summary: "rm -rf scratch",
      approvalRule: { provider: "codex" },
    });

    await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "accept" });
  });

  it("forwards Allow for all as the proposed exec-policy amendment", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "always.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-always", text: "clean up" });
    const opened = await recorder.until((event) => event.type === "request.opened");
    await instance.adapter.respondToRequest("t-always", opened.requestId!, { behavior: "always" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm", "-rf"] } },
    });
  });

  it("auto-approves commands in fullAuto without opening a request", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-auto", text: "clean up" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "accept" });
  });

  it("auto-accepts MCP elicitation for delegated bot tools", async () => {
    await create({ mode: "mcp" });
    const dump = join(scratch, "mcp.json");
    process.env.FAKE_CODEX_DUMP = dump;
    setTurnPolicy("t-mcp-auto", { autonomy: "autonomous", access: "full", permissions: { delegation: true } });

    await instance.adapter.sendTurn({ threadId: "t-mcp-auto", text: "list bots" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      action: "accept",
      content: {},
    });
  });

  it("exposes exact models, keeps max for 5.6 and sends localImage", async () => {
    await create();
    expect(instance.models).toEqual({
      default: "gpt-5.6-sol",
      options: [
        { id: "gpt-6-astra", label: "GPT-6 Astra" },
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      ],
    });
    const dump = join(scratch, "image.json");
    const image = join(scratch, "photo.png");
    writeFileSync(image, "png");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-image",
      text: "inspect",
      model: "gpt-5.6-sol",
      attachments: [{ id: "a", name: "photo.png", mime: "image/png", size: 3, path: image }],
      reasoning: "max",
    } as any);
    await recorder.until((event) => event.type === "turn.completed");
    const turnStart = JSON.parse(readFileSync(dump, "utf8")).calls.find((call: any) => call.method === "turn/start");
    expect(turnStart.params.effort).toBe("max");
    expect(turnStart.params.input[1]).toEqual({ type: "localImage", path: image });

    const cappedDump = join(scratch, "capped.json");
    process.env.FAKE_CODEX_DUMP = cappedDump;
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go", model: "gpt-5.4", reasoning: "max" } as any);
    await recorder.until((event) => event.type === "turn.completed" && recorder.events.filter((item) => item.type === "turn.completed").length === 2);
    const capped = JSON.parse(readFileSync(cappedDump, "utf8")).calls.find((call: any) => call.method === "turn/start");
    expect(capped.params.effort).toBe("xhigh");

    const astraDump = join(scratch, "astra.json");
    process.env.FAKE_CODEX_DUMP = astraDump;
    await instance.adapter.sendTurn({ threadId: "t-astra", text: "go", model: "gpt-6-astra", reasoning: "max" } as any);
    await recorder.until((event) => event.type === "turn.completed" && recorder.events.filter((item) => item.type === "turn.completed").length === 3);
    const astra = JSON.parse(readFileSync(astraDump, "utf8")).calls.find((call: any) => call.method === "turn/start");
    expect(astra.params.effort).toBe("max");
  });

  // multibot: „Fast mode" to service tier `priority` codeksa. Test pilnuje, że
  // flaga DOCIERA do `turn/start` jako `serviceTierForTurn` (a nie `serviceTier`,
  // które zapisałoby tier w wątku i przeżyło wyłączenie przełącznika) i że przy
  // wyłączonym przełączniku oraz na `gpt-5.4-mini` (pusta lista `serviceTiers`)
  // w żądaniu nie ma jej wcale.
  it("wysyła service tier priority tylko przy włączonym fast mode", async () => {
    await create();
    const onDump = join(scratch, "fast-on.json");
    process.env.FAKE_CODEX_DUMP = onDump;
    await instance.adapter.sendTurn({ threadId: "t-fast-on", text: "go", model: "gpt-5.6-sol", fastMode: true } as any);
    await recorder.until((event) => event.type === "turn.completed");
    const on = JSON.parse(readFileSync(onDump, "utf8")).calls.find((call: any) => call.method === "turn/start");
    expect(on.params.serviceTierForTurn).toBe("priority");
    expect(on.params.serviceTier).toBeUndefined();

    const offDump = join(scratch, "fast-off.json");
    process.env.FAKE_CODEX_DUMP = offDump;
    await instance.adapter.sendTurn({ threadId: "t-fast-off", text: "go", model: "gpt-5.6-sol" } as any);
    await recorder.until((event) => event.type === "turn.completed" && recorder.events.filter((item) => item.type === "turn.completed").length === 2);
    const off = JSON.parse(readFileSync(offDump, "utf8")).calls.find((call: any) => call.method === "turn/start");
    expect(off.params.serviceTierForTurn).toBeUndefined();

    const miniDump = join(scratch, "fast-mini.json");
    process.env.FAKE_CODEX_DUMP = miniDump;
    await instance.adapter.sendTurn({ threadId: "t-fast-mini", text: "go", model: "gpt-5.4-mini", fastMode: true } as any);
    await recorder.until((event) => event.type === "turn.completed" && recorder.events.filter((item) => item.type === "turn.completed").length === 3);
    const mini = JSON.parse(readFileSync(miniDump, "utf8")).calls.find((call: any) => call.method === "turn/start");
    expect(mini.params.serviceTierForTurn).toBeUndefined();
  });

  it("denies a disabled workspace tool even when legacy fullAuto is on", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "policy-dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    setTurnPolicy("t-policy-deny", { autonomy: "autonomous", permissions: { terminal: false, file: true } });

    await instance.adapter.sendTurn({ threadId: "t-policy-deny", text: "clean up" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "decline" });
  });

  it("rejects a second turn while one is in flight", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    const dump = join(scratch, "interrupt.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).calls).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "codex-thread-1", turnId: "codex-turn-1" },
    });
  });

  it("a missing binary surfaces as a failed turn, and snapshot says unavailable", async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });
});

// multibot (H3): the gate says Codex really drives the bot's computer. Codex's
// mcp_servers used to carry `agents` alone, so this pins the regression.
describe("codexMcpConfig", () => {
  const base = { threadId: "t1", text: "hi" } as unknown as SendTurnInput;

  it("mounts the bot computer next to agents", () => {
    const cfg = codexMcpConfig({
      ...base,
      integrations: {
        agents: { command: "node", args: ["a.js"], env: {} },
        localComputer: { command: "py", args: ["-m", "server.computer_mcp"], env: { PYTHONPATH: "e" } },
      },
    } as unknown as SendTurnInput);
    expect(Object.keys(cfg.config!.mcp_servers).sort()).toEqual(["agents", "computer"]);
    expect(cfg.config!.mcp_servers.computer).toMatchObject({ command: "py" });
  });

  it("marks the computer required so a slow start cannot silently drop it", () => {
    const cfg = codexMcpConfig({
      ...base,
      integrations: {
        agents: { command: "node", args: ["a.js"], env: {} },
        localComputer: { command: "py", args: [], env: {} },
      },
    } as unknown as SendTurnInput);
    // codex pomija niegotowe serwery opcjonalne — komputer musi być wymagany
    expect(cfg.config!.mcp_servers.computer).toMatchObject({ required: true });
    // agents wstaje od razu, więc zostaje opcjonalny (mniejsze ryzyko dla tury)
    expect(cfg.config!.mcp_servers.agents).not.toHaveProperty("required");
  });

  it("auto-approves computer tools and whitelists them (A4)", () => {
    const cfg = codexMcpConfig({
      ...base,
      integrations: { localComputer: { command: "py", args: [], env: {} } },
    } as unknown as SendTurnInput);
    const computer = cfg.config!.mcp_servers.computer as Record<string, unknown>;
    // komputer to sandbox bota — bez elicitation na każdy tool; inaczej 15-min
    // timeout odmawiał po cichu i bot nie nawigował
    expect(computer.default_tools_approval_mode).toBe("auto");
    // whitelist musi być mirrorem prawdziwego zestawu narzędzi
    expect(computer.enabled_tools).toEqual([...COMPUTER_MCP_TOOLS]);
    // Python na telefonie wstaje ~4 s; 30 s zapasu przed błędem required
    expect(computer.startup_timeout_ms).toBe(30_000);
  });

  it("mounts the computer even when there are no peer agents", () => {
    const cfg = codexMcpConfig({
      ...base,
      integrations: { localComputer: { command: "py", args: [], env: {} } },
    } as unknown as SendTurnInput);
    expect(Object.keys(cfg.config!.mcp_servers)).toEqual(["computer"]);
  });

  it("sends no config block at all when the bot has neither", () => {
    expect(codexMcpConfig(base)).toEqual({});
  });

  it("mounts composio as an HTTP MCP server with the consumer key header", () => {
    const cfg = codexMcpConfig({
      ...base,
      integrations: {
        agents: { command: "node", args: ["a.js"], env: {} },
        composio: { key: "ck_secret" },
      },
    } as unknown as SendTurnInput);
    expect(Object.keys(cfg.config!.mcp_servers).sort()).toEqual(["agents", "composio"]);
    // codex nie używa pola `type` (wykrywa HTTP po `url`) i wysyła klucz przez
    // `http_headers`, a nie `headers` (format Claude'a)
    expect(cfg.config!.mcp_servers.composio).toEqual({
      url: "https://connect.composio.dev/mcp",
      http_headers: { "x-consumer-api-key": "ck_secret" },
    });
  });
});

// multibot (H3): `thread/resume` nie dokłada nowych serwerów MCP do istniejącego
// wątku, więc zestaw serwerów jedzie w kursorze — zmiana zestawu = nowy wątek.
describe("cursor carries the mcp set", () => {
  const cfg = (integrations: unknown) =>
    codexMcpConfig({ threadId: "t1", text: "hi", integrations } as unknown as SendTurnInput);

  it("keys the cursor by server names, order-independent", () => {
    const a = cursorMcpKey(cfg({ agents: { command: "n", args: [], env: {} }, localComputer: { command: "p", args: [], env: {} } }));
    const b = cursorMcpKey(cfg({ localComputer: { command: "p", args: [], env: {} }, agents: { command: "n", args: [], env: {} } }));
    // Wersje OBU zestawów narzędzi jadą w kluczu — czytane ze źródła, żeby ich
    // podniesienie nie wywracało tego testu, a samo podpięcie było sprawdzone.
    // Regresja: brak wersji przy `agents` sprawił, że dodane `send_file` nigdy
    // nie doszło do istniejących wątków.
    expect(a).toBe(`agents@${AGENTS_TOOLS_VERSION},computer@${COMPUTER_TOOLS_VERSION}`);
    expect(b).toBe(a);
    expect(cursorMcpKey(cfg(undefined))).toBe("");
  });

  it("treats a pre-computer cursor as a different set, so the thread restarts", () => {
    expect(splitCursor("thr_123")).toEqual({ threadId: "thr_123", mcpKey: "" });
    expect(splitCursor("thr_123#agents,computer")).toEqual({ threadId: "thr_123", mcpKey: "agents,computer" });
  });

  it("survives a `#` inside the codex thread id", () => {
    expect(splitCursor("thr#odd#agents")).toEqual({ threadId: "thr#odd", mcpKey: "agents" });
  });

  it("starts a new thread only when the turn brings a server the thread lacks", () => {
    expect(cursorPlan("thr_1", "agents,computer@2")).toEqual({ resume: null, key: "agents,computer@2" });
    expect(cursorPlan("thr_1#agents", "agents,computer@2")).toEqual({ resume: null, key: "agents,computer@2" });
    // Codex zapamietuje liste narzedzi w watku, wiec nowy zestaw = nowy watek
    expect(cursorPlan("thr_1#agents,computer@1", "agents,computer@2")).toEqual({
      resume: null,
      key: "agents,computer@2",
    });
    expect(cursorPlan(undefined, "agents")).toEqual({ resume: null, key: "agents" });
  });

  // Komputer nie wstał na jedną turę — wątek ma go zamontowanego, więc restart
  // kosztowałby całą pamięć bota za nic. Zapis zostaje przy szerszym zestawie.
  it("keeps the thread (and the wider set) when the turn has fewer servers", () => {
    expect(cursorPlan("thr_1#agents,computer@2", "agents")).toEqual({ resume: "thr_1", key: "agents,computer@2" });
    expect(cursorPlan("thr_1#agents,computer@2", "")).toEqual({ resume: "thr_1", key: "agents,computer@2" });
    expect(cursorPlan("thr_1#agents,computer@2", "agents,computer@2")).toEqual({
      resume: "thr_1",
      key: "agents,computer@2",
    });
  });
});
