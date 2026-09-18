// multibot: historia rutyny ma pokazywać WYNIK, nie samo „w kolejce". Panel
// jest ostatnim ogniwem: nazywa wynik po ludzku, tłumaczy KOD porażki, który
// przyszedł z serwera, i nie udaje, że przebieg trwa, gdy nikt go już nie
// rozstrzygnie.
import { describe, expect, it } from "vitest";

import { runFailure, runLabel, runTitle, runsSummary } from "./RoutinesPanel";

const at = new Date(2026, 8, 11, 9, 5).toISOString();

describe("wynik przebiegu rutyny", () => {
  it("nazywa sukces, porażkę i przebieg w toku, w języku czytelnika", () => {
    expect(runLabel("ok", false)).toBe("Success");
    expect(runLabel("ok", true)).toBe("Sukces");
    expect(runLabel("error", false)).toBe("Failed");
    expect(runLabel("error", true)).toBe("Błąd");
    // `queued` to stan przejściowy — tura leci, wyniku jeszcze nie ma
    expect(runLabel("queued", true)).toBe("W toku");
  });

  it("nie melduje „w toku” o przebiegu, którego nikt już nie rozstrzygnie", () => {
    // `unknown` = harness zgasł w trakcie; tak samo wygląda historia sprzed `ok`
    expect(runLabel("unknown", true)).toBe("—");
    expect(runLabel("unknown", false)).toBe("—");
    expect(runLabel(undefined, false)).toBe("—");
    expect(runLabel(null, true)).toBe("—");
  });

  it("tłumaczy kod porażki od harnessu i zostawia komunikat dostawcy bez zmian", () => {
    expect(runFailure({ at, status: "error", reason: "interrupted" }, true)).toBe("Przerwane przez użytkownika");
    expect(runFailure({ at, status: "error", reason: "interrupted" }, false)).toBe("Interrupted by the user");
    expect(runFailure({ at, status: "error", reason: "watchdog" }, false)).toBe("The provider stopped responding");
    expect(runFailure({ at, status: "unknown", reason: "harness-stopped" }, true)).toBe("Harness został zatrzymany");
    // surowy tekst dostawcy idzie jak stoi — nie ma go jak przetłumaczyć
    expect(runFailure({ at, status: "error", error: "bot is already working" }, true)).toBe("bot is already working");
    // nieznany kod z nowszego serwera: lepiej pokazać kod niż nic
    expect(runFailure({ at, status: "error", reason: "future-code" }, true)).toBe("future-code");
    expect(runFailure({ at, status: "ok" }, true)).toBeNull();
  });

  it("podpowiedź kropki niesie czas, wynik i — przy porażce — powód", () => {
    // udany przebieg kończy się samym wynikiem — bez doklejonego powodu
    expect(runTitle({ at, status: "ok" }, true)).toMatch(/— Sukces$/);
    const failed = runTitle({ at, status: "error", reason: "watchdog" }, false);
    expect(failed).toContain("Failed");
    expect(failed).toContain("The provider stopped responding");
  });

  it("pasek kropek mówi kolorem, więc czytnik ekranu dostaje zdanie", () => {
    const runs = [
      { at, status: "ok" },
      { at, status: "error", reason: "interrupted" },
      { at, status: "ok" },
      { at, status: "unknown" },
    ];
    // szare kropki też są policzone — inaczej suma nie zgadza się z obrazkiem
    expect(runsSummary(runs, true)).toBe("Historia przebiegów: 2 udanych, 1 nieudanych, 1 bez wyniku z 4");
    expect(runsSummary(runs, false)).toBe("Run history: 2 successful, 1 failed, 1 with no result out of 4");
    expect(runsSummary([{ at, status: "queued" }], true)).toBe("Historia przebiegów: 0 udanych, 0 nieudanych, 1 w toku z 1");
    // sam sukces i porażka: bez pustych ogonów w zdaniu
    expect(runsSummary([{ at, status: "ok" }], false)).toBe("Run history: 1 successful, 0 failed out of 1");
    expect(runsSummary([], false)).toBe("Run history: 0 successful, 0 failed out of 0");
  });
});
