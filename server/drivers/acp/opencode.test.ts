import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { OpenCodeAgentDriver, opencodeAcpArgs } from "./opencode.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("OpenCode ACP driver", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch = "";

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "multibot-opencode-acp-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("uses official OpenCode ACP argv", () => {
    // `opencode acp` rejects --model (1.18) — the model rides in the config env.
    expect(opencodeAcpArgs()).toEqual(["acp"]);
  });

  it("runs Zen without passing Go key to child", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await OpenCodeAgentDriver.create({
      instanceId: "opencode-test",
      displayName: "OpenCode",
      environment: { OPENCODE_API_KEY: "go-value" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "opencode-zen", text: "hello", model: "opencode/big-pickle" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["acp"]);
    expect(seen.env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify({ model: "opencode/big-pickle" }));
    expect(seen.env.OPENCODE_API_KEY).toBeUndefined();
  });

  it("mounts the Composio MCP server in the ACP http shape", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await OpenCodeAgentDriver.create({
      instanceId: "opencode-test",
      displayName: "OpenCode",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "opencode-composio",
      text: "hello",
      model: "opencode/big-pickle",
      integrations: { composio: { key: "ck_test", url: "https://connect.composio.dev/mcp" } },
    });
    await recorder.until((event) => event.type === "turn.completed");

    // OpenCode validates session/new with zod: url + an object of headers
    // (the pre-fix shape) failed the whole RPC, so the turn never ran.
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers).toContainEqual({
      type: "http",
      name: "composio",
      url: "https://connect.composio.dev/mcp",
      headers: [{ name: "x-consumer-api-key", value: "ck_test" }],
    });
  });

  it("rejects Go turn before spawning without key", async () => {
    instance = await OpenCodeAgentDriver.create({
      instanceId: "opencode-test",
      displayName: "OpenCode",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    await expect(instance.adapter.sendTurn({ threadId: "opencode-go", text: "hello", model: "opencode-go/gpt-5.6-luna" }))
      .rejects.toThrow(/OpenCode Go API key required/);
  });
});
