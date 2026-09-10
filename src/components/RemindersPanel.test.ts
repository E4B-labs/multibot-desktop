// multibot: panel przypomnień — druga zakładka prawego slotu. Test pilnuje
// tego, co widać: format daty w strefie czytelnika, kolejność WZIĘTĄ z serwera
// (klient jej nie sortuje), wyszarzenie odpalonych, obie akcje na wierszu i
// obie ścieżki wejścia (menu „⋮" + pigułka zdarzenia w transkrypcie).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { formatAt } from "./RemindersPanel";
import { relativeTime } from "@/lib/relativeTime";

const panel = readFileSync(new URL("./RemindersPanel.tsx", import.meta.url), "utf8");
const menu = readFileSync(new URL("./ChatHeaderMenu.tsx", import.meta.url), "utf8");
const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("../state/store.tsx", import.meta.url), "utf8");

describe("formatAt", () => {
  it("pokazuje datę i godzinę w języku czytelnika, w formacie 24-godzinnym", () => {
    const at = new Date(2026, 8, 11, 9, 5).toISOString();
    expect(formatAt(at, false)).toMatch(/September/);
    expect(formatAt(at, false)).toMatch(/09:05/);
    expect(formatAt(at, true)).toMatch(/wrze/);
    expect(formatAt(at, true)).toMatch(/09:05/);
  });

  it("czyta pełny moment ISO ze strefą, więc nie zgaduje własnej", () => {
    // ta sama chwila zapisana dwoma offsetami daje ten sam wynik
    const a = formatAt("2026-09-11T07:05:00.000Z", false);
    const b = formatAt("2026-09-11T09:05:00+02:00", false);
    expect(a).toBe(b);
  });
});

describe("relativeTime w panelu", () => {
  it("daje wyprzedzenie dla przyszłości i „temu” dla przeszłości", () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    expect(relativeTime(now + 2 * 3_600_000, now, "en")).toBe("in 2 hours");
    expect(relativeTime(now - 3 * 60_000, now, "en")).toBe("3 minutes ago");
  });
});

describe("panel przypomnień", () => {
  it("bierze listę CAŁEGO warsztatu i nie sortuje jej po swojemu", () => {
    expect(panel).toContain('api("/api/reminders")');
    // kolejność rozstrzyga serwer — klient nie może mieć własnego `.sort(`
    expect(panel).not.toContain(".sort(");
  });

  it("odpalone są wyszarzone, nie skasowane", () => {
    expect(panel).toContain('const fired = r.status === "fired"');
    expect(panel).toContain('fired && "opacity-55"');
  });

  it("każdy wiersz ma drzemkę na godzinę i kasowanie", () => {
    expect(panel).toContain("/snooze`");
    expect(panel).toContain("JSON.stringify({ minutes: 60 })");
    expect(panel).toContain('{ method: "DELETE" }');
  });

  it("wiersz mówi, KTÓRY bot przypomni — awatar plus nazwa", () => {
    expect(panel).toContain("<BotAvatar");
    expect(panel).toContain("state.bots.find((b) => b.id === r.botId)");
  });

  it("jest po polsku i po angielsku, jak reszta interfejsu", () => {
    expect(panel).toContain('polish ? "Przypomnienia" : "Reminders"');
    expect(panel).toContain('polish ? "Odłóż o godzinę" : "Snooze 1 h"');
    expect(panel).toContain('polish ? "Usuń" : "Delete"');
  });
});

describe("wejścia do panelu", () => {
  it("menu trzech kropek ma Przypomnienia obok Rutyn bota", () => {
    expect(menu).toContain('label: polish ? "Rutyny bota" : "Bot routines"');
    expect(menu).toContain('label: polish ? "Przypomnienia" : "Reminders"');
    expect(menu).toContain('dispatch({ type: "toggleRoutines", open: true, tab: "reminders" })');
  });

  it("pigułka odpalonego przypomnienia w transkrypcie otwiera ten panel", () => {
    expect(chat).toContain('message.event.type === "reminder-created" || message.event.type === "reminder"');
    expect(chat).toContain('dispatch({ type: "toggleRoutines", open: true, tab: "reminders" })');
  });

  it("prawy slot renderuje panel po zakładce, nie po drugim przełączniku", () => {
    expect(app).toContain('state.routinesOpen && state.routinesTab === "reminders" && <RemindersPanel />');
    expect(app).toContain('state.routinesOpen && state.routinesTab === "routines" && bot');
  });

  it("kliknięcie w drugą zakładkę przełącza panel, zamiast go zamykać", () => {
    expect(store).toContain("action.tab !== undefined && action.tab !== state.routinesTab");
    expect(store).toContain('routinesTab: "routines",');
  });
});
