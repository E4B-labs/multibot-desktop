// Czyste kawałki karty pytania. Suita chodzi w środowisku `node`
// (vite.config.ts), więc testujemy to, co da się sprawdzić bez DOM-u:
// czy karta zgody nie zwija się w pokwitowanie i co to pokwitowanie mówi.
import { describe, expect, it } from "vitest";

import { isApprovalCard } from "@/state/store";
import {
  approvalScopeNote,
  approvalValues,
  deliveryLabel,
  optionScopeHint,
  splitApprovalSubtitle,
} from "./OptionCard";

const card = (patch: Record<string, unknown> = {}) =>
  ({ title: "Które dni?", subtitle: "", options: ["A", "B", "C", "D"], ...patch }) as any;

describe("isApprovalCard", () => {
  it("pytanie zwija się w pokwitowanie", () => {
    expect(isApprovalCard(card())).toBe(false);
  });
  it("karta zgody NIE — jej podtytuł to ślad autoweryfikacji", () => {
    expect(isApprovalCard(card({ kind: "approval" }))).toBe(true);
  });
  it("karty zgody sprzed pola `kind` poznajemy po opcji „Allow for all", () => {
    expect(isApprovalCard(card({ options: ["Allow", "Deny", "Allow for all"] }))).toBe(true);
  });
  it("pytanie z opcją Allow zostaje pytaniem — od tego zależy, czy odpowiedź dojdzie do modelu", () => {
    // Bez tego odpowiedź „Allow" na PYTANIE szła do dostawcy jako zgoda i model
    // nigdy jej nie widział.
    expect(isApprovalCard(card({ options: ["Allow", "Block"] }))).toBe(false);
  });
});

describe("deliveryLabel", () => {
  it("do potwierdzenia z serwera mówi „wysłano do <bot>", () => {
    expect(deliveryLabel(card(), "Ogar", false)).toBe("sent to Ogar");
    expect(deliveryLabel(card(), "Ogar", true)).toBe("wysłano do: Ogar");
  });
  it("po potwierdzeniu przechodzi w „odebrane", () => {
    expect(deliveryLabel(card({ delivered: true }), "Ogar", false)).toBe("received");
    expect(deliveryLabel(card({ delivered: true }), "Ogar", true)).toBe("odebrane");
  });
});

// Karta zgody ma powiedzieć, o co chodzi, ZANIM człowiek kliknie: co bot chce
// zrobić, z jakimi wartościami, czym różnią się przyciski i czego zgoda nie
// cofa. Te cztery kawałki są czyste, więc sprawdzamy je bez DOM-u.
describe("splitApprovalSubtitle", () => {
  it("samo streszczenie zostaje akcją, noty nie ma", () => {
    expect(splitApprovalSubtitle("rm -rf /tmp/x")).toEqual({ action: "rm -rf /tmp/x", note: "" });
  });
  it("nota autoweryfikacji (druga linia) idzie osobno — w jednym wierszu zlewała się z poleceniem", () => {
    // Dokładnie ten kształt skleja `server/index.ts` przy `request.opened`.
    expect(splitApprovalSubtitle('git push\nZgoda automatyczna, reguła: "git"')).toEqual({
      action: "git push",
      note: 'Zgoda automatyczna, reguła: "git"',
    });
  });
  it("pusty podtytuł nie wywraca karty", () => {
    expect(splitApprovalSubtitle("")).toEqual({ action: "", note: "" });
  });
});

describe("approvalValues", () => {
  it("polecenie zostaje jedną wartością, bez etykiety", () => {
    expect(approvalValues("rm -rf /tmp/x")).toEqual([{ label: "", value: "rm -rf /tmp/x" }]);
  });
  it("wejście narzędzia rozkłada się na wiersze klucz → wartość", () => {
    // `server/drivers/claude.ts` wkłada tu `JSON.stringify(input)`, gdy nie ma
    // ani polecenia, ani adresu — dotąd szło to na ekran jednym ciągiem.
    expect(approvalValues('{"file_path":"G:/a.ts","limit":20}')).toEqual([
      { label: "file_path", value: "G:/a.ts" },
      { label: "limit", value: "20" },
    ]);
  });
  it("puste pola wypadają", () => {
    expect(approvalValues('{"file_path":"G:/a.ts","content":"  "}')).toEqual([
      { label: "file_path", value: "G:/a.ts" },
    ]);
  });
  it("JSON ucięty na 200 znakach nie znika — pokazujemy go tak, jak przyszedł", () => {
    expect(approvalValues('{"command":"echo aaa')).toEqual([
      { label: "", value: '{"command":"echo aaa' },
    ]);
  });
  it("nic do pokazania = zero wierszy (blok się nie rysuje)", () => {
    expect(approvalValues("   ")).toEqual([]);
  });
});

describe("optionScopeHint", () => {
  it("jedna akcja kontra zapamiętana reguła — to jest zakres zgody", () => {
    expect(optionScopeHint("Allow", true)).toBe("tylko ta jedna akcja");
    expect(optionScopeHint("Allow for all", true)).toBe("zapamiętuje regułę na przyszłość");
    expect(optionScopeHint("Allow for all", false)).toBe("remembers a rule for next time");
    expect(optionScopeHint("Deny", false)).toBe("the bot will not do this");
  });
  it("opcja pytania nie dostaje podpowiedzi", () => {
    expect(optionScopeHint("Tylko desktop", true)).toBe("");
  });
});

describe("approvalScopeNote", () => {
  it("stałe zdanie w obu językach", () => {
    expect(approvalScopeNote(false)).toBe(
      "Approval covers the proposed action only; it does not undo work already done.",
    );
    expect(approvalScopeNote(true)).toBe(
      "Zgoda dotyczy proponowanej akcji — nie cofa pracy już wykonanej.",
    );
  });
});
