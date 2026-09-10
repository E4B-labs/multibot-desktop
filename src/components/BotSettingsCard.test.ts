import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: układ zakładki „Ogólne" ma twarde wymagania od Kacpra (29.08):
// karta System bez opisu, karta Bot dokładnie pod nią, a opis Autoweryfikacji
// przepisany z aplikacji wzorcowej z podmienioną nazwą bota. Wszystkie trzy
// widać w źródle, więc nie trzeba do tego renderować drzewa Reacta.
const panel = readFileSync(new URL("./AppSettingsPanel.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./BotSettingsCard.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./TimeZonePicker.tsx", import.meta.url), "utf8");
const types = readFileSync(new URL("../lib/autoVerifyTypes.ts", import.meta.url), "utf8");

describe("karta Bot w ustawieniach ogólnych", () => {
  it("stoi pod kartą System, a ta jest pod Profilem", () => {
    const profil = panel.indexOf('"Profil" : "Profile"');
    const system = panel.indexOf('>System</div>');
    const bot = panel.indexOf("<BotSettingsCard");
    expect(profil).toBeGreaterThan(-1);
    expect(system).toBeGreaterThan(profil);
    expect(bot).toBeGreaterThan(system);
  });

  it("pod nagłówkiem System nie ma już żadnego opisu", () => {
    const system = panel.indexOf('>System</div>');
    // od nagłówka do pierwszego wiersza karty nie może paść nic o ustawieniach
    // systemowych — zostaje samo słowo „System".
    const doPierwszegoWiersza = panel.slice(system, panel.indexOf("<MicrophoneRow", system));
    expect(doPierwszegoWiersza).not.toContain("text-ink-secondary");
    expect(panel).not.toContain("ustawienia systemowe zostają bez zmian");
  });

  it("opis Autoweryfikacji mówi o MultiBocie, nie o cudzym bocie", () => {
    expect(card).toContain("MultiBot sprawdza każdą akcję przed jej uruchomieniem");
    expect(card.toLowerCase()).not.toContain("grok bot");
    // opis nie obiecuje już dodawania reguł — edytor wyleciał z UI
    expect(card).not.toContain("Dodaj reguły");
    expect(card).not.toContain("Add rules");
  });

  // multibot: edytor „Reguł Autoweryfikacji" usunięty z UI (wrzesień 2026) —
  // w danych i na serwerze `autoVerify.rules` zostaje, znika tylko karta.
  it("nie ma już edytora reguł ani jego martwego kodu", () => {
    for (const leftover of [
      "Reguły Autoweryfikacji",
      "Auto-verification rules",
      "np. odpowiadaj za mnie na e-maile",
      "Dodaj regułę",
      "addRule",
      "setRules",
      "DecisionSelect",
      "inputClass",
      "Te reguły dotyczą tylko Ciebie.",
    ]) {
      expect(card, `został ślad edytora reguł: ${leftover}`).not.toContain(leftover);
    }
  });

  it("domyślnie pyta o wszystko", () => {
    // Bez żadnej reguły MultiBot pyta o każdą akcję: to wynika z włączonego
    // przełącznika i pustej listy (server/auto-verify.ts decideAction).
    expect(types).toContain("{ enabled: true, rules: [] }");
  });

  it("nie obiecuje wbudowanych kontroli bezpieczeństwa, których nie mamy", () => {
    expect(card).not.toContain("Wbudowane kontrole bezpieczeństwa");
  });

  it("stan idzie na serwer, bo tylko tam da się wstrzymać akcję bota", () => {
    // Gdyby reguły siedziały w localStorage, harness by ich nie zobaczył
    // i Autoweryfikacja byłaby samą dekoracją.
    expect(card).toContain('authFetch("/api/config"');
    expect(card).not.toContain("localStorage");
  });

  it("lista stref jest pełna i szuka po tym, co widać na ekranie", () => {
    expect(picker).toContain("listTimeZones");
    expect(picker).toContain("filterTimeZones");
    // pozycja automatyczna zapisuje się jako pusty ciąg, nie jako nazwa strefy
    expect(picker).toContain("AUTO_TIMEZONE");
    expect(picker).toContain("Wykryj automatycznie");
  });
});
