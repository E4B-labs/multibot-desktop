#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | persistent | exit-early | hang | malformed
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//                      | deaf (alive but NOTHING on stdout, ever — proot żyje,
//                        claude w środku nie; watchdog tury ma to wyłapać)
//                      | deaf-once (jak wyżej, ale tylko pierwszy proces; drugi
//                        odpowiada normalnie — do testu respawnu i powtórki)
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt} as JSON, so the
//                      test can assert on argv shape and env hygiene
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { existsSync, writeFileSync } from "node:fs";

let mode = process.env.FAKE_CLAUDE_MODE ?? "happy";
// deaf-once: pierwszy proces milczy, każdy następny gada. Znacznik na dysku, bo
// procesy są osobne — driver ubija ten pierwszy i stawia drugi.
if (mode === "deaf-once") {
  const flag = process.env.FAKE_CLAUDE_DEAF_FLAG ?? "";
  if (flag && existsSync(flag)) mode = "persistent";
  else {
    if (flag) writeFileSync(flag, "1");
    mode = "deaf";
  }
}
if (mode === "deaf") {
  // Żywy proces, zero bajtów na stdout — dokładnie ten przypadek, w którym
  // `stdin.destroyed` kłamie, że worker żyje.
  setInterval(() => {}, 1_000);
}

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

let stdin = "";
let initialized = false;
let turns = 0;
const handlePrompt = (raw: string) => {
  turns += 1;
  if (mode === "deaf") return; // tura wpada do rury i nikt nie odpowiada
  let prompt: unknown = null;
  try {
    prompt = JSON.parse(raw);
  } catch {
    /* leave null — the test will see it */
  }

  if (process.env.FAKE_CLAUDE_DUMP) {
    writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({ argv, env: process.env, prompt }, null, 2));
  }

  const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
  const model = argAfter("--model") ?? "claude-fake";

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }

  if (!initialized) {
    initialized = true;
    out({ type: "system", subtype: "init", session_id: sessionId, model });
  }

  if (mode === "hang") {
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight
    setInterval(() => {}, 1_000);
    return;
  }

  // multibot: wygasły OAuth w CLI 2.1.268 — tekst asystenta + result is_error,
  // proces NIE wychodzi (transkrypt z telefonu Kacpra, 11.09.2026 21:18)
  if (mode === "auth-expired") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] } });
    out({ type: "result", is_error: true, subtype: "error_during_execution", result: "Failed to authenticate: OAuth session expired and could not be refreshed" });
    return;
  }
  // zwykła odpowiedź modelu, która MÓWI o logowaniu — ma zostać dymkiem
  if (mode === "prose-auth") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "Your OAuth session expired most likely because the refresh token was revoked; a 401 means the API key was rejected." }] } });
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01 });
    return;
  }
  // result z błędem i powodem, bez żadnego tekstu asystenta
  if (mode === "error-result") {
    out({ type: "result", is_error: true, subtype: "error_max_turns", result: "Reached max turns (1)" });
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  if (mode === "stream") {
    const delta = (d: unknown) => out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    delta({ type: "thinking_delta", thinking: "hmm" });
    delta({ type: "text_delta", text: "hello from " });
    delta({ type: "text_delta", text: "fake claude" });
    // subagent narration — the driver must drop this, not render it
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello from fake claude" },
        { type: "tool_use", id: "tu-1", name: "Bash" },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01 });
  if (mode !== "persistent") process.exit(0);
};

process.stdin.on("data", (c) => {
  stdin += c;
  let nl;
  while ((nl = stdin.indexOf("\n")) !== -1) {
    const line = stdin.slice(0, nl).trim();
    stdin = stdin.slice(nl + 1);
    if (line) handlePrompt(line);
  }
});
