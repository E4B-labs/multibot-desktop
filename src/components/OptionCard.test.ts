// Czyste kawałki karty pytania. Suita chodzi w środowisku `node`
// (vite.config.ts), więc testujemy to, co da się sprawdzić bez DOM-u:
// czy karta zgody nie zwija się w pokwitowanie i co to pokwitowanie mówi.
import { describe, expect, it } from "vitest";

import { isApprovalCard } from "@/state/store";
import { deliveryLabel } from "./OptionCard";

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
