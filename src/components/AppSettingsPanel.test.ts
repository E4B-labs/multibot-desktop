import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { visibleSettingsTabs } from "./AppSettingsPanel";

// multibot: animacje ikon w szynie sekcji ustawień mają twarde warunki od
// Kacpra — gałki suwaków nie mogą wyjechać poza swoje szyny, każda animacja
// trwa 3 s, a na kafelku nie ma żadnej kolorowej nakładki. Wszystkie trzy
// dają się sprawdzić na źródle, bo siedzą w geometrii, nie w wyglądzie.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const panel = readFileSync(new URL("./AppSettingsPanel.tsx", import.meta.url), "utf8");
const icons = readFileSync(new URL("./SettingsTabIcons.tsx", import.meta.url), "utf8");

/** Ciało @keyframes liczone po nawiasach — pierwsza klamra zamykająca kończy
 *  dopiero pierwszą klatkę, więc cięcie na niej gubiłoby resztę. */
function bodyOf(name: string): string {
  const start = css.indexOf("@keyframes " + name);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  return "";
}

/** Wartości liczbowe z wywołań danej funkcji CSS, np. translateX(-9.5px). */
function argsOf(text: string, fn: string): number[] {
  return text
    .split(fn + "(")
    .slice(1)
    .map((chunk) => Number.parseFloat(chunk));
}

function declared(selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at));
}

describe("animacje ikon w szynie ustawień", () => {
  // szyna suwaka biegnie od x=3 do x=21; gałki startują na 14, 8 i 16
  const RAIL_FROM = 3;
  const RAIL_TO = 21;
  const starts = [14, 8, 16];

  it("gałki suwaków nie wyjeżdżają poza swoje szyny", () => {
    const shifts = starts.map((_, i) => {
      const rule = declared(".settings-slider-knob--" + (i + 1));
      expect(rule, "brak reguły dla gałki " + (i + 1)).not.toBe("");
      const a = Number.parseFloat(rule.slice(rule.indexOf("--knob-a:") + 9));
      const b = Number.parseFloat(rule.slice(rule.indexOf("--knob-b:") + 9));
      expect(Number.isNaN(a) || Number.isNaN(b)).toBe(false);
      return [0, a, b];
    });

    shifts.forEach((legs, i) => {
      for (const leg of legs) {
        const x = starts[i] + leg;
        expect(x, "gałka " + (i + 1) + " wyjeżdża na " + x).toBeGreaterThanOrEqual(RAIL_FROM);
        expect(x, "gałka " + (i + 1) + " wyjeżdża na " + x).toBeLessThanOrEqual(RAIL_TO);
      }
    });
  });

  it("gałki naprawdę jadą tylko w poziomie", () => {
    const body = bodyOf("settings-slider-knob");
    expect(body).not.toBe("");
    expect(body).toContain("translateX");
    expect(body).not.toContain("translateY");
  });

  it("każda z trzech animacji trwa 3 s", () => {
    for (const name of ["settings-slider-knob", "settings-refresh-spin", "settings-wrench-turn"]) {
      const at = css.indexOf("animation: " + name);
      expect(at, "brak deklaracji animacji " + name).toBeGreaterThan(-1);
      expect(css.slice(at, css.indexOf(";", at))).toContain(" 3s ");
    }
  });

  it("strzałki kończą obrót tam, gdzie zaczęły", () => {
    const turns = argsOf(bodyOf("settings-refresh-spin"), "rotate");
    expect(turns.length).toBeGreaterThan(0);
    for (const deg of turns) expect(deg % 360).toBe(0);
  });

  it("klucz kołysze się na tyle mało, żeby nie ucięła go krawędź ikony", () => {
    const angles = argsOf(bodyOf("settings-wrench-turn"), "rotate");
    expect(angles.length).toBeGreaterThan(0);
    for (const deg of angles) expect(Math.abs(deg)).toBeLessThanOrEqual(6);
  });

  it("kafelek nie dostaje kolorowej nakładki na kliknięcie", () => {
    expect(panel).not.toContain("bg-accent/");
    expect(panel).not.toContain("settings-tab-press");
  });

  it("animacje włącza data-playing, więc stoją dopóki nikt nie kliknie", () => {
    expect(icons).toContain("data-playing");
    expect(css).toContain("[data-settings-tab-icon][data-playing]");
  });

  it("narzędzia są pośrodku, a aktualizacje na dole", () => {
    expect(panel.indexOf('id: "other"')).toBeLessThan(panel.indexOf('id: "update"'));
  });
});

// Zakładka admina pokazuje cudze konta i rotuje hasło serwera. Widzi ją
// WYŁĄCZNIE właściciel — a „jeszcze nie wiem, kim jesteś" i „nie jesteś
// właścicielem" to dwie różne rzeczy, więc obie chowają zakładkę, ale panel
// mówi o tej pierwszej wprost.
describe("zakładka Admin zależy od roli", () => {
  const ids = (role: Parameters<typeof visibleSettingsTabs>[0]) => visibleSettingsTabs(role).map((tab) => tab.id);

  it("widzi ją tylko właściciel", () => {
    expect(ids("owner")).toContain("admin");
    expect(ids("member")).not.toContain("admin");
    expect(ids("loading")).not.toContain("admin");
    expect(ids("unknown")).not.toContain("admin");
  });

  it("reszta szyny zostaje nietknięta dla każdego", () => {
    expect(ids("member")).toEqual(["general", "other", "update"]);
    expect(ids("owner")).toEqual(["general", "other", "admin", "update"]);
  });
});
