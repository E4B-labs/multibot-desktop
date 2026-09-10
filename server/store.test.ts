// Store persistence contract: bots.json + messages-<threadId>.json are
// the durable record — everything here must survive a process restart
// except `busy`, which never does (no turn survives one either).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { BOT_SHAPES, defaultSelectionTarget, managedBotPatch, Store, sortMessages, withoutLegacyGroupLeak, type BotRecord, type Message } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("normalizes history by timestamp and deterministic id tie-break", () => {
    const messages = [
      { id: "z", at: 2 },
      { id: "b", at: 1 },
      { id: "a", at: 1 },
    ];

    expect(sortMessages(messages).map((message) => message.id)).toEqual(["a", "b", "z"]);
  });

  it("createBot seeds a greeting and an onboarding card", () => {
    const store = new Store(selection);
    const bot = store.createBot();

    const messages = store.messagesFor(bot.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "bot", kind: "text" });
    expect(messages[1].kind).toBe("options");
    expect(messages[1].card?.options.length).toBeGreaterThan(1);
    expect(bot.modelSelection).toEqual(selection());
  });

  it("keeps provider and model selection independent per bot", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    store.patchBot(first.id, { modelSelection: { instanceId: "codex", model: "gpt-5.6-luna" } });
    store.patchBot(second.id, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });

    expect(store.bot(first.id)?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.6-luna" });
    expect(store.bot(second.id)?.modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
    expect(new Store(selection).bot(first.id)?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.6-luna" });
  });

  it("rotates colors across created bots", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    expect(first.color).not.toBe(second.color);
  });

  it("accepts editable bot profile fields and rejects internal state", () => {
    expect(managedBotPatch({
      name: "  Researcher  ",
      description: "Find evidence",
      color: "purple",
      mascotShape: "star",
      avatarUrl: "https://example.com/avatar.webp",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      hidden: true,
      ownerId: "stolen-owner",
      threadId: "stolen-thread",
    })).toEqual({
      name: "Researcher",
      description: "Find evidence",
      color: "purple",
      mascotShape: "star",
      avatarUrl: "https://example.com/avatar.webp",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      hidden: true,
    });
    expect(() => managedBotPatch({ color: "infrared" })).toThrow("color must be one of");
    expect(() => managedBotPatch({ avatarUrl: "javascript:alert(1)" })).toThrow("avatarUrl must be");
    expect(() => managedBotPatch({ temporary: true })).toThrow("only be set while creating");
    expect(managedBotPatch({ temporary: true }, { temporary: true })).toEqual({ temporary: true });
    // Bot proszacy o "wave"/"gear"/"shield" dostawal je zapisane, a klient
    // rysowal wtedy czarnego kursora — odrzucamy, wymieniajac dozwolone.
    expect(() => managedBotPatch({ mascotShape: "wave" })).toThrow("mascotShape must be one of");
  });

  // Rozjazd list to czarna maskotka: serwer zapisuje ksztalt, ktorego klient
  // nie umie narysowac. Czytamy zrodlo klienta, bo import ciagnalby React.
  it("keeps the server shape list identical to the client's", () => {
    const source = readFileSync(new URL("../src/lib/mascotShapes.ts", import.meta.url), "utf8");
    const names = (constant: string) => {
      const body = new RegExp(`${constant} = \\[([^\\]]*)\\]`).exec(source);
      if (!body) throw new Error(`${constant} not found in src/lib/mascotShapes.ts`);
      return [...body[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
    };

    expect([...names("MASCOT_SHAPES"), ...names("LEGACY_SHAPES")]).toEqual(BOT_SHAPES);
  });

  it("falls unknown persisted shapes back to blob on load", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { mascotShape: "gear" });

    expect(new Store(selection).bot(bot.id)?.mascotShape).toBe("blob");
  });

  it("persists bots and messages across a restart, resetting busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy", busy: true });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi there" });

    const reloaded = new Store(selection);
    const back = reloaded.bot(bot.id)!;
    expect(back.name).toBe("Testy");
    expect(back.busy).toBe(false);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
  });

  it("patchMessage merges card patches and returns null for unknown ids", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.messagesFor(bot.threadId)[1];

    const patched = store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "Work & projects" },
    });
    expect(patched?.card?.answered).toBe("Work & projects");
    expect(store.patchMessage(bot.threadId, "nope", {})).toBeNull();
  });

  it("deleteBot removes the bot and its transcript file", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const file = join(DATA_DIR, `messages-${bot.threadId}.json`);
    expect(existsSync(file)).toBe(true);

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.bot(bot.id)).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(store.deleteBot(bot.id)).toBe(false);
  });

  it("setResumeCursor persists per-instance continuations", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "codex", "thread-xyz");

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-abc", codex: "thread-xyz" });
  });

  it("keeps temporary subagents out of persisted bot records", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({ temporary: true });
    expect(bot.temporary).toBe(true);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))).not.toContainEqual(expect.objectContaining({ id: bot.id }));
  });

  it("migrates orphaned selections to a custom model first", () => {
    const store = new Store(selection);
    const orphan = store.createBot();
    store.patchBot(orphan.id, { modelSelection: { instanceId: "local", model: "hermes-agent" } });

    expect(
      store.migrateOrphanedSelections([
        {
          instanceId: "claude",
          driverKind: "claudeAgent",
          models: { default: "claude-sonnet-5" },
          snapshot: { state: "available" },
        },
        {
          instanceId: "local-qwen",
          driverKind: "openaiCompatible",
          models: { default: "qwen2.5" },
          snapshot: { state: "unavailable" },
        },
      ]),
    ).toBe(1);
    expect(new Store(selection).bot(orphan.id)?.modelSelection).toEqual({
      instanceId: "local-qwen",
      model: "qwen2.5",
    });
  });

  it("leaves an explicit empty selection when no provider exists", () => {
    const store = new Store(selection);
    const orphan = store.createBot();
    store.patchBot(orphan.id, { modelSelection: { instanceId: "gone", model: "old" } });

    expect(store.migrateOrphanedSelections([])).toBe(1);
    expect(store.bot(orphan.id)?.modelSelection).toEqual({ instanceId: "", model: "" });
  });

  // New bots go to a CLI driver: it is the one that can answer without a key.
  describe("defaultSelectionTarget", () => {
    const target = (instanceId: string, driverKind: string, state: "available" | "unavailable" = "available") =>
      ({ instanceId, driverKind, models: { default: `${instanceId}-model` }, snapshot: { state } });

    it("picks the CLI driver over a configured endpoint", () => {
      const pick = defaultSelectionTarget([target("local-qwen", "openaiCompatible"), target("codex", "codex")]);
      expect(pick?.instanceId).toBe("codex");
    });

    it("prefers claude, then codex", () => {
      expect(defaultSelectionTarget([target("opencode", "opencode"), target("codex", "codex")])?.instanceId).toBe("codex");
      expect(
        defaultSelectionTarget([target("codex", "codex"), target("claude", "claudeAgent")])?.instanceId,
      ).toBe("claude");
    });

    // "available" only means the driver loaded — opencode says so with no key
    // configured, and would fail on the first turn. With no claude or codex in
    // the fleet the first live target wins, whatever it is.
    it("falls back to the first live target when no CLI driver is there", () => {
      const pick = defaultSelectionTarget([target("opencode", "opencode"), target("local-qwen", "openaiCompatible")]);
      expect(pick?.instanceId).toBe("opencode");
    });

    it("prefers a live CLI driver over a dead one", () => {
      const pick = defaultSelectionTarget([target("claude", "claudeAgent", "unavailable"), target("codex", "codex")]);
      expect(pick?.instanceId).toBe("codex");
    });

    it("takes whatever is there when it is the whole fleet, and nothing from nothing", () => {
      expect(defaultSelectionTarget([target("local-qwen", "openaiCompatible")])?.instanceId).toBe("local-qwen");
      expect(defaultSelectionTarget([])).toBeUndefined();
    });
  });

  it("seedIfEmpty creates exactly one starter bot, once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);

    const reloaded = new Store(selection);
    reloaded.seedIfEmpty();
    expect(reloaded.bots).toHaveLength(1);
  });

  it("tolerates a corrupt bots.json by starting empty", () => {
    const store = new Store(selection);
    store.createBot();
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
  });

  it("busy is wiped even when bots.json says otherwise", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((b) => b.id === bot.id)!.busy = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.busy).toBe(false);
  });
});

// Serwery ≤0.5.27 zapisywały turę grupową na prywatnym wątku członka WIDOCZNIE:
// koperta jako bańka użytkownika, odpowiedź jako bańka bota, plus czip pokoju.
// Nowy serwer już tak nie robi, ale te zapisy leżą na dyskach — czytanie musi je
// odsiać, inaczej dalej się rysują.
describe("withoutLegacyGroupLeak", () => {
  const msg = (over: Partial<Message> & { id: string }): Message =>
    ({ role: "bot", kind: "text", at: over.at ?? 0, ...over } as Message);
  const envelope = '[Group chat "Ekipa" with @Atlas, @Researcher. The user writes to the whole group.]\n\nUser: hej';

  it("drops the envelope, the bot's group reply and the group chip", () => {
    const kept = withoutLegacyGroupLeak([
      msg({ id: "hello", at: 1, text: "Hey — I'm your new bot." }),
      msg({ id: "chip", at: 2, kind: "room", room: { id: "r1", name: "Ekipa", bot_ids: [], ownerBotId: "b1", status: "running", groupId: "g1" } }),
      msg({ id: "env", at: 3, role: "user", text: envelope }),
      msg({ id: "reply", at: 4, text: "hello from Atlas" }),
      msg({ id: "mine", at: 5, role: "user", text: "a teraz prywatnie" }),
      msg({ id: "answer", at: 6, text: "jasne" }),
    ]).map((m) => m.id);

    expect(kept).toEqual(["hello", "mine", "answer"]);
  });

  const peerChip = (id: string, at: number) =>
    msg({ id, at, kind: "room", room: { id: "r0", name: "Zadanie", bot_ids: [], ownerBotId: "b1", status: "done", event: "texted" } });

  it("keeps a peer chip AFTER the leaked window and drops one inside it", () => {
    const kept = withoutLegacyGroupLeak([
      msg({ id: "env", at: 1, role: "user", text: envelope }),
      peerChip("inside", 2),
      msg({ id: "mine", at: 3, role: "user", text: "a teraz prywatnie" }),
      peerChip("after", 4),
    ]).map((m) => m.id);

    expect(kept).toEqual(["mine", "after"]);
  });

  it("survives an array that is not in chronological order and keeps the caller's order", () => {
    const kept = withoutLegacyGroupLeak([
      msg({ id: "reply", at: 4, text: "hello from Atlas" }),
      msg({ id: "env", at: 3, role: "user", text: envelope }),
      peerChip("peer", 2),
      msg({ id: "hello", at: 1, text: "Hey — I'm your new bot." }),
    ]).map((m) => m.id);

    expect(kept).toEqual(["peer", "hello"]);
  });

  // Bieżący serwer zapisuje kopertę i odpowiedź grupową JAKO `hidden`, więc
  // filtr nie ma prawa ich brać za początek starego okna: między nimi a
  // następną wiadomością człowieka stoją WIDOCZNE rzeczy, na które ktoś czeka
  // (karta zgody, odpowiedź na prywatną wiadomość dołożoną do tej samej tury).
  it("a hidden envelope opens no window over the visible messages after it", () => {
    const kept = withoutLegacyGroupLeak([
      msg({ id: "env", at: 1, role: "user", text: envelope, hidden: true }),
      msg({ id: "groupReply", at: 2, text: "hello from Atlas", hidden: true }),
      msg({ id: "card", at: 3, kind: "options" }),
      msg({ id: "answer", at: 4, text: "a to już do Ciebie" }),
    ]).map((m) => m.id);

    expect(kept).toEqual(["env", "groupReply", "card", "answer"]);
  });

  it("a message that only starts like the envelope is a normal user message", () => {
    const looksClose = [
      msg({ id: "a", at: 1, role: "user", text: '[Group chat "Ekipa" — czemu tam nikt nie odpisuje?' }),
      msg({ id: "b", at: 2, text: "sprawdzam" }),
    ];
    expect(withoutLegacyGroupLeak(looksClose).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("leaves a clean thread untouched", () => {
    const clean = [msg({ id: "a", at: 1, role: "user", text: "hej" }), msg({ id: "b", at: 2, text: "cześć" })];
    expect(withoutLegacyGroupLeak(clean).map((m) => m.id)).toEqual(["a", "b"]);
  });
});
