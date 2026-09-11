// multibot: historia rutyny ma pokazywać WYNIK, nie samo „w kolejce". Test
// pilnuje trzech rzeczy: słowa zamiast surowego statusu (dwujęzycznie),
// podpowiedzi kropki z tekstem błędu i tego, że karta rutyny naprawdę rysuje
// pasek przebiegów oraz ostatni błąd.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runLabel, runTitle } from "./RoutinesPanel";

const panel = readFileSync(new URL("./RoutinesPanel.tsx", import.meta.url), "utf8");

describe("wynik przebiegu rutyny", () => {
  it("nazywa sukces, porażkę i przebieg w toku, w języku czytelnika", () => {
    expect(runLabel("ok", false)).toBe("Success");
    expect(runLabel("ok", true)).toBe("Sukces");
    expect(runLabel("error", false)).toBe("Failed");
    expect(runLabel("error", true)).toBe("Błąd");
    // `queued` to stan przejściowy — tura leci, wyniku jeszcze nie ma
    expect(runLabel("queued", true)).toBe("W toku");
    expect(runLabel(undefined, false)).toBe("Running");
  });

  it("podpowiedź kropki niesie czas, wynik i — przy porażce — tekst błędu", () => {
    const at = new Date(2026, 8, 11, 9, 5).toISOString();
    expect(runTitle({ at, status: "ok" }, true)).toContain("Sukces");
    expect(runTitle({ at, status: "ok" }, true)).not.toContain(":undefined");
    const failed = runTitle({ at, status: "error", error: "the provider stopped responding" }, false);
    expect(failed).toContain("Failed");
    expect(failed).toContain("the provider stopped responding");
  });

  it("karta rysuje pasek ostatnich przebiegów i ostatni błąd", () => {
    expect(panel).toContain("r.last_runs.slice(0, 10).map");
    expect(panel).toContain('RUN_DOT: Record<string, string> = { ok: "bg-success", error: "bg-danger" }');
    expect(panel).toContain("r.last_runs[0]?.error &&");
    // wynik na początku linii — ogon i tak się nie mieści przy 360 px
    expect(panel).toContain("`${runLabel(run.status, polish)} · ${new Date(run.at).toLocaleString()}`");
    expect(panel).toContain("text-[12px] text-danger");
  });
});
