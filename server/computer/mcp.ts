// The computer MCP server — spawned inside a bot's agent process as
// `integrations.localComputer`, so a bot driven by claude/codex/acp gets the
// same browser and terminal a bot driven by the harness has.
//
// A thin pass-through, exactly like the Python `server.computer_mcp` it
// replaces: every tool is one `POST /api/internal/computer/tool` and the
// harness owns the browser, the container and the screen. Zero browser logic
// here, so a take-over from the UI keeps working for every driver.
//
// Raw JSON-RPC over stdio (house style, matches agents-proxy / computer-proxy).
// stdout is the MCP channel — never console.log here.
//
// Env, injected by the harness:
//   OMB_HARNESS_URL  base URL of the harness
//   OMB_BOT_ID       the calling bot
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
import { resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { harnessRequest } from "../drivers/harness-request.ts";

const HARNESS = process.env.OMB_HARNESS_URL ?? "https://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";

export const TOOLS = [
  {
    name: "screenshot",
    description:
      "A picture of the VISIBLE part of the active tab (JPEG) — the viewport only, not the whole scrollable page, not other tabs, not the desktop outside the browser. The MOST EXPENSIVE tool here: ~0.4 s and 1.5-2k image tokens per call. For content and for clicking use read_page/find instead — ~40x cheaper, and they give you refs. Reach for a screenshot when you genuinely need the LAYOUT: a page with no text (PDF, canvas, map), checking how something looks, or clicking by coordinates when there is no ref. Coordinates read off this image are CSS viewport pixels, which is exactly what click(x, y) takes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "navigate",
    description:
      "Open an address in the active tab (does not open a new tab — it replaces the current one). The url must be http:// or https://. Waits for the page to load, so read_page right after sees the new page; the result shows the final address after any redirect. ALL previous refs are void after a navigation — start with read_page or find.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "read_page",
    description:
      'THE FIRST tool on any page — ~40x cheaper than a screenshot and enough to click with. Returns `elements`: a tree of interactive elements and headings with numbered refs, e.g. `[e12] button "Log in"`, `[e13] textbox "Email" placeholder="jane@..."`; indentation is nesting. Pass those refs to click(ref=...), type_text(ref=...) and actions. Also returns `text` (visible innerText, cut at 4000 chars), `url` and `title`. Refs are valid UNTIL THE DOCUMENT CHANGES: after a navigation, after a click that reloaded the page, and after a refresh, call read_page (or find) again. It does NOT return cross-origin iframe content, invisible elements, or anything on a PDF tab (the built-in viewer exposes no innerText — the answer then carries a `note` and screenshot is the only way).',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find",
    description:
      'Find elements matching `query` and return their refs — cheaper than a whole read_page when you know what you are after ("Log in", "email", "cart"). Matches case-insensitively against visible text, aria-label, placeholder, the field\'s current value and the role name (button, link, textbox, checkbox, combobox, heading…), so find("textbox") lists the input fields. The refs are the same ones read_page gives, and go stale the same way. No result means matches: 0 — try another word or read_page.',
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "click",
    description:
      "Click an element. PREFER `ref` from read_page/find — it hits the element regardless of scrolling and layout, and the page is scrolled to it for you. x/y (CSS pixels off a screenshot) are the fallback when there is no ref. `button`: left (default), middle, right; always a single click. It does NOT wait for the effect: after a click that may have changed the page, call read_page. If you are going to type and press Enter right after, do the whole thing in one `actions` call instead of three.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"] },
      },
    },
  },
  {
    name: "move",
    description:
      "Glide the cursor through the given points `[[x, y], ...]` (CSS pixels of the active tab). Movement only, no clicking — the cursor is visible on the computer's screen, so this is how you show the user where you are looking, and how you hover things. One call does the whole path, so the motion is smooth; one call per point jumps.",
    inputSchema: {
      type: "object",
      properties: { points: { type: "array", items: { type: "array", items: { type: "number" } } } },
      required: ["points"],
    },
  },
  {
    name: "type_text",
    description:
      'Type text. With `ref` (from read_page/find) the field is clicked first and then typed into; without `ref` the text goes wherever the focus currently is. It does NOT clear the field (it appends — clear with key("a", ["ctrl"]) then key("Delete")) and does NOT press Enter (that is a separate key("Enter")). The text goes in as one Input.insertText, so it fires no per-character key events: fields that only react to keydown (autocomplete, input masks, some editors) may miss it — type character by character with `key` there.',
    inputSchema: { type: "object", properties: { text: { type: "string" }, ref: { type: "string" } }, required: ["text"] },
  },
  {
    name: "key",
    description:
      'Press and release a key wherever the focus is. `name`: a single character or a name — Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp/ArrowDown/ArrowLeft/ArrowRight, F1-F12, Space. `modifiers`: any of ctrl, shift, alt, meta — key("a", ["ctrl"]) selects all, key("Tab", ["shift"]) moves focus back. You cannot hold a key down or send two ordinary keys at once — only a key plus modifiers.',
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, modifiers: { type: "array", items: { type: "string" } } },
      required: ["name"],
    },
  },
  {
    name: "scroll",
    description:
      'Scroll by `dy` pixels (positive is down) with the cursor over point (x, y). (x, y) MUST be over something scrollable — the wheel hits the element under the cursor, so a point over a fixed panel does nothing. The middle of the window is a safe choice; one "screen" is the viewport height. It returns no new view: call read_page afterwards (refs from before the scroll stay valid, the document did not change). To reach a specific element do not scroll at all — click(ref=…) scrolls it into view itself.',
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, dy: { type: "number" }, dx: { type: "number" } },
      required: ["x", "y"],
    },
  },
  {
    name: "actions",
    description:
      'Run several steps in ONE call — use this instead of a run of separate click/type_text/key calls. The whole sequence runs in one browser session and ends with a fresh page snapshot, so you need no read_page afterwards. Steps (max 20): {"type":"click","ref":"e5"} or {"x":…,"y":…,"button":"left"}; {"type":"type_text","text":"…","ref":"e6"}; {"type":"key","name":"Enter","modifiers":["ctrl"]}; {"type":"scroll","dy":400,"x":…,"y":…}; {"type":"wait","ms":500} (max 10000). It STOPS and reports when a step fails AND when a step changed the document (navigation, reload, form submit) — later refs would belong to a page that no longer exists. So put the step that changes the page LAST; `navigate` is not a batch step for the same reason. Returns executed, stopped (step and reason, or null), skipped and page (a snapshot like read_page).',
    inputSchema: {
      type: "object",
      properties: { steps: { type: "array", items: { type: "object" } } },
      required: ["steps"],
    },
  },
  {
    name: "status",
    description:
      "Whether the computer's browser is up and on what address. Rarely needed: every other tool brings the browser up itself. Note that all bots in this workspace share ONE browser and one top tab — opening a new tab changes the view for everyone.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "computer_exec",
    description:
      "Run a shell command on the bot's computer — the SAME filesystem the browser sees. THE CHEAPEST tool here (well under the cost of one click): downloading a file, checking a URL with curl, listing a directory, computing something — do it HERE instead of clicking through a browser. No state between calls (each one is a fresh `bash -lc`, so `cd` and variables do not carry over — chain with &&). 60 s timeout. A non-zero exit is a tool error, so a grep that matched nothing looks like a failure — append `|| true` when an empty result is a correct result.",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
] as const;

const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const text = (id: unknown, t: string, isError = false) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) } });

async function callTool(id: unknown, name: string, args: Record<string, unknown>) {
  const res = await harnessRequest(`${HARNESS}/api/internal/computer/tool`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ self: BOT_ID, name, args }),
  });
  let body: any = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    /* non-JSON body is reported as-is below */
  }
  if (res.status >= 400) return text(id, String(body?.error ?? res.body ?? `HTTP ${res.status}`), true);
  // Only screenshot answers with an image; everything else is JSON the model reads.
  if (typeof body?.image === "string" && body.image) {
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "image", data: body.image, mimeType: "image/jpeg" }] } });
  }
  return text(id, JSON.stringify(body ?? {}, null, 2));
}

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "computer", version: "1" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    try {
      return await callTool(msg.id, String(msg.params?.name ?? ""), msg.params?.arguments ?? {});
    } catch (e) {
      return text(msg.id, `computer tool failed: ${(e as Error).message}`, true);
    }
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

// Imported by the harness (for TOOLS) as well as spawned as a script — only the
// script half may take stdin.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
