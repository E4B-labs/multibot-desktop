// multibot: panel „Zużycie" to okno na cztery liczby z `GET /api/bots/:id/usage`.
// Środowisko testów to node (`test.environment` w `vite.config.ts`), więc
// sprawdzamy zachowanie wyciągnięte z komponentu — tak jak testy ComputerPanel.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_USAGE,
  formatTokens,
  parseUsage,
  pollUsage,
  tokensPerTurn,
  turnsLabel,
  usageErrorMessage,
  usageRows,
} from "./UsagePanel";

const panel = readFileSync(new URL("./UsagePanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../../server/workspace.ts", import.meta.url), "utf8");

describe("parseUsage", () => {
  it("przepisuje kształt WorkspaceUsage z serwera", () => {
    expect(parseUsage({ prompt_tokens: 120, completion_tokens: 34, total_tokens: 154, turns: 2 })).toEqual({
      prompt_tokens: 120,
      completion_tokens: 34,
      total_tokens: 154,
      turns: 2,
    });
  });

  it("pusta albo popsuta odpowiedź daje zera, nigdy NaN", () => {
    expect(parseUsage({})).toEqual(EMPTY_USAGE);
    expect(parseUsage(null)).toEqual(EMPTY_USAGE);
    expect(parseUsage({ prompt_tokens: "nie liczba", turns: -5 })).toEqual(EMPTY_USAGE);
  });

  it("pola przychodzące jako napisy (JSON z telefonu) nadal są liczbami", () => {
    expect(parseUsage({ total_tokens: "1500" }).total_tokens).toBe(1500);
  });
});

describe("formatTokens", () => {
  it("grupuje tysiące w obu językach", () => {
    // pl-PL rozdziela wąską spacją nierozdzielającą, en-US przecinkiem
    expect(formatTokens(1234567, true).replace(/\s| | /g, "")).toBe("1234567");
    expect(formatTokens(1234567, false)).toBe("1,234,567");
  });

  it("zero zostaje zerem, śmieci też", () => {
    expect(formatTokens(0, false)).toBe("0");
    expect(formatTokens(Number.NaN, false)).toBe("0");
  });
});

describe("tokensPerTurn", () => {
  it("dzieli sumę przez tury", () => {
    expect(tokensPerTurn({ ...EMPTY_USAGE, total_tokens: 900, turns: 4 })).toBe(225);
  });

  it("zero tur nie dzieli przez zero", () => {
    expect(tokensPerTurn({ ...EMPTY_USAGE, total_tokens: 900, turns: 0 })).toBe(0);
  });
});

describe("turnsLabel", () => {
  it("po angielsku odmienia tylko liczbę mnogą", () => {
    expect(turnsLabel(1, false)).toBe("turn");
    expect(turnsLabel(0, false)).toBe("turns");
    expect(turnsLabel(2, false)).toBe("turns");
  });

  it("po polsku ma trzy formy, z wyjątkiem 12–14", () => {
    expect(turnsLabel(1, true)).toBe("tura");
    expect(turnsLabel(2, true)).toBe("tury");
    expect(turnsLabel(4, true)).toBe("tury");
    expect(turnsLabel(5, true)).toBe("tur");
    expect(turnsLabel(12, true)).toBe("tur");
    expect(turnsLabel(13, true)).toBe("tur");
    expect(turnsLabel(22, true)).toBe("tury");
    expect(turnsLabel(0, true)).toBe("tur");
  });
});

describe("usageRows", () => {
  const usage = { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000, turns: 2 };

  // Sumę i liczbę tur niesie kafelek nad listą, więc lista ich nie powtarza —
  // rozbija to, z czego suma się bierze.
  it("pokazuje wejście, wyjście, tury i średnią", () => {
    const rows = usageRows(usage, false);
    expect(rows.map((row) => row.label)).toEqual([
      "Input tokens",
      "Output tokens",
      "Turns",
      "Average per turn",
    ]);
    expect(rows.map((row) => row.value)).toEqual(["800", "200", "2", "500"]);
  });

  it("ma komplet etykiet po polsku", () => {
    const rows = usageRows(usage, true);
    expect(rows.map((row) => row.label)).toEqual([
      "Tokeny wejściowe",
      "Tokeny wyjściowe",
      "Tury",
      "Średnio na turę",
    ]);
    expect(rows.every((row) => row.label.trim().length > 0)).toBe(true);
  });
});

describe("usageErrorMessage", () => {
  it("mówi, co się stało, zamiast pokazywać numer statusu", () => {
    expect(usageErrorMessage(404, true)).toBe("Tego bota już nie ma.");
    expect(usageErrorMessage(404, false)).toBe("This bot no longer exists.");
    expect(usageErrorMessage(403, false)).toBe("You cannot see this bot's usage.");
    expect(usageErrorMessage(0, true)).toBe("Brak połączenia z serwerem.");
  });

  it("przy błędzie serwera zostawia numer, bo jest po co zajrzeć do logu", () => {
    expect(usageErrorMessage(503, false)).toContain("503");
    expect(usageErrorMessage(418, false)).toContain("418");
  });
});

describe("pollUsage", () => {
  afterEach(() => vi.useRealTimers());

  it("pyta od razu, potem co 5 s, i przestaje po sprzątnięciu", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => "ok" as const);
    const stop = pollUsage(load);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("skasowany bot (404) zatrzymuje pytanie, jednorazowy błąd nie", async () => {
    vi.useFakeTimers();
    const retry = vi.fn(async () => "retry" as const);
    pollUsage(retry);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retry).toHaveBeenCalledTimes(3);

    const gone = vi.fn(async () => "stop" as const);
    pollUsage(gone);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gone).toHaveBeenCalledTimes(1);
  });
});

describe("obudowa panelu", () => {
  it("idzie przez wspólny SidePanel, ma własny klucz szerokości i wiersz w karcie bota", () => {
    expect(panel).toContain("<SidePanel");
    expect(panel).toContain('from "./ResizablePanel"');
    expect(panel).toContain('storageKey="multibot.panelWidth.usage"');
    expect(panel).toContain("data-shell-header");
    // Kotwica dla harnessu QA (`D:\tmp\mb-qa\e2e\usage-ui.mjs` czyta z niej sumę).
    expect(panel).toContain("data-usage-total");
    // Sztywna szerokość na `<aside>` blokowałaby ciągnięcie (ResizablePanel.test.ts).
    expect(panel).not.toContain("<aside");
    // Wiersz w karcie bota: otwiera panel per bot i wraca do ustawień.
    expect(settings).toContain('polish ? "Zużycie" : "Usage"');
    expect(settings).toContain("<UsagePanel key={bot.id}");
    expect(settings).toContain("onBack={() => setUsageOpen(false)}");
    // Nazwy pól muszą się zgadzać z `WorkspaceUsage` na serwerze.
    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens", "turns"]) {
      expect(workspace, `serwer nie ma już pola ${field}`).toContain(field);
      expect(panel, `panel nie czyta pola ${field}`).toContain(field);
    }
  });
});
