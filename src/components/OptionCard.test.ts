// Czyste kawałki karty pytania. Suita chodzi w środowisku `node`
// (vite.config.ts), więc testujemy to, co da się sprawdzić bez DOM-u:
// jak z zaznaczonych checkboxów powstaje odpowiedź i co mówi pokwitowanie.
import { describe, expect, it } from "vitest";

import { deliveryLabel, pickedAnswer } from "./OptionCard";

const card = (patch: Record<string, unknown> = {}) =>
  ({ title: "Które dni?", subtitle: "", options: ["A", "B", "C", "D"], ...patch }) as any;

describe("pickedAnswer", () => {
  it("skleja WYBRANE etykiety w kolejności opcji, nie klikania", () => {
    expect(pickedAnswer(["A", "B", "C", "D"], new Set([3, 2]))).toBe("C, D");
  });
  it("pusty wybór to pusta odpowiedź — nie ma czego wysyłać", () => {
    expect(pickedAnswer(["A", "B"], new Set())).toBe("");
  });
  it("jedna zaznaczona opcja jedzie bez przecinka", () => {
    expect(pickedAnswer(["A", "B"], new Set([1]))).toBe("B");
  });
});

describe("deliveryLabel", () => {
  it("do potwierdzenia z serwera mówi „wysłano do <bot>", () => {
    expect(deliveryLabel(card(), "Ogar", false)).toBe("sent to Ogar");
    expect(deliveryLabel(card(), "Ogar", true)).toBe("wysłano do Ogar");
  });
  it("po potwierdzeniu przechodzi w „odebrane", () => {
    expect(deliveryLabel(card({ delivered: true }), "Ogar", false)).toBe("received");
    expect(deliveryLabel(card({ delivered: true }), "Ogar", true)).toBe("odebrane");
  });
});
