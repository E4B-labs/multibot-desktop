import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_HEADER_ACTIONS, HIDDEN_CHAT_HEADER_ACTIONS, FLY_MS, LETTER_MS, TYPE_MS, UNROLL_MS, letterDelay } from "./ChatHeaderMenu";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const menu = readFileSync(new URL("./ChatHeaderMenu.tsx", import.meta.url), "utf8");

/** Treść jednej reguły CSS, od selektora do zamykającej klamry. */
function rule(selector: string): string {
  const at = css.indexOf(selector + " {");
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
}

// multibot: schowanie pięciu ikon pod jeden przycisk niesie jedno ryzyko —
// że któraś funkcja po cichu zniknie. Te testy pilnują kompletu i tego, że
// nagłówek czatu oddał je menu wyłącznie na pulpicie.
describe("menu akcji w nagłówku czatu", () => {
  it("niesie widoczne funkcje, bez powtórzeń", () => {
    expect([...CHAT_HEADER_ACTIONS].sort()).toEqual(["computer", "find", "reminders", "routines", "skills"]);
  });

  it("kolejność jest ta sama co na telefonie", () => {
    // multibot: „Przypomnienia" stoją TUŻ OBOK „Rutyn bota" (Kacper 10.09.2026)
    expect([...CHAT_HEADER_ACTIONS]).toEqual(["computer", "routines", "reminders", "skills", "find"]);
  });

  // hidden per Kacper 07.09.2026, panels kept
  it("schowane pozycje nie wchodzą do menu, ale ich obsługa zostaje", () => {
    expect(HIDDEN_CHAT_HEADER_ACTIONS).toEqual(["inspector", "rooms", "team"]);
    for (const action of HIDDEN_CHAT_HEADER_ACTIONS) {
      expect(CHAT_HEADER_ACTIONS).not.toContain(action);
      expect(menu).toContain(`    ${action}: {`);
    }
  });

  it("ChatView pokazuje menu na pulpicie, a pięć ikon poza nim", () => {
    const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    expect(chat).toContain("<ChatHeaderMenu");
    expect(chat).toContain("isElectron ? (");
  });
});

// multibot: sekwencja otwierania — zwój, lot kropek, pisanie liter, po
// sekundzie na fazę. Czasy żyją w dwóch miejscach naraz (stałe w TS i klatki
// w CSS) i muszą się zgadzać, bo rozjazd widać jako przeskok w połowie ruchu.
describe("sekwencja otwierania menu", () => {
  it("każda z trzech faz trwa 0,2 s", () => {
    expect(UNROLL_MS).toBe(200);
    expect(FLY_MS).toBe(200);
    expect(TYPE_MS).toBe(200);
    expect(UNROLL_MS + FLY_MS + TYPE_MS).toBe(600);
  });

  it("CSS trzyma te same czasy co komponent", () => {
    expect(rule(".menu-unroll")).toContain(" " + UNROLL_MS / 1000 + "s ");
    expect(rule(".menu-dot")).toContain(" " + FLY_MS / 1000 + "s ");
    expect(rule(".menu-letter")).toContain(" " + LETTER_MS / 1000 + "s ");
  });

  it("pierwsza litera rusza od razu, ostatnia kończy równo z końcem fazy", () => {
    expect(letterDelay(0, 12)).toBe(0);
    const last = letterDelay(11, 12);
    expect(last * 1000 + LETTER_MS).toBe(TYPE_MS);
  });

  it("litery idą po kolei, od lewej", () => {
    const delays = [0, 1, 2, 3, 4, 5].map((i) => letterDelay(i, 6));
    const sorted = [...delays].sort((a, b) => a - b);
    expect(delays).toEqual(sorted);
    expect(new Set(delays).size).toBe(delays.length);
  });

  it("etykieta jednoliterowa i pusta nie wywracają obliczeń", () => {
    expect(letterDelay(0, 1)).toBe(0);
    expect(letterDelay(0, 0)).toBe(0);
    expect(letterDelay(99, 5)).toBe(letterDelay(4, 5));
  });

  it("po sekwencji panel wraca do zwykłej etykiety, bez opakowań na litery", () => {
    expect(menu).toContain("done ? (");
    expect(menu).toContain("<span>{label}</span>");
  });

  it("zwój przycina panel, zamiast go skalować albo rozciągać wysokością", () => {
    const frames = css.slice(css.indexOf("@keyframes menu-unroll"));
    const body = frames.slice(0, frames.indexOf("}", frames.indexOf("to {")));
    expect(body).toContain("clip-path");
    expect(body).not.toContain("scale");
    expect(body).not.toContain("height");
  });
});
