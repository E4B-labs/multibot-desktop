// Testy przypinania certyfikatu (TOFU). Czysta funkcja, więc bez gniazd:
// reguła zaufania ma być sprawdzalna bez stawiania serwera TLS.
import { describe, expect, it } from "vitest";

import { CERT_CHANGED, verifyFingerprint } from "./tls-pin.mjs";

const FP = "AA:BB:CC:DD";

describe("tls fingerprint pin", () => {
  it("pierwszy kontakt zapamiętuje odcisk", () => {
    expect(verifyFingerprint({ stored: undefined, actual: FP })).toEqual({ learned: FP });
    expect(verifyFingerprint({ stored: "", actual: FP })).toEqual({ learned: FP });
  });

  it("ten sam certyfikat przechodzi, niezależnie od zapisu odcisku", () => {
    expect(verifyFingerprint({ stored: FP, actual: FP })).toEqual({});
    expect(verifyFingerprint({ stored: "aabbccdd", actual: FP })).toEqual({});
  });

  it("inny certyfikat to twardy błąd, nie ciche zaufanie", () => {
    expect(() => verifyFingerprint({ stored: FP, actual: "AA:BB:CC:DE" })).toThrow("server certificate changed");
    try {
      verifyFingerprint({ stored: FP, actual: "AA:BB:CC:DE" });
    } catch (err) {
      expect(err.code).toBe(CERT_CHANGED);
    }
  });

  it("brak certyfikatu też jest błędem", () => {
    expect(() => verifyFingerprint({ stored: FP, actual: undefined })).toThrow(/no certificate/);
    expect(() => verifyFingerprint({ stored: undefined, actual: "" })).toThrow(/no certificate/);
  });
});
