import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regresja z PR #52 (BlobAvatar zastapil CursorAvatar): maskotki w sidebarze,
// na gornym pasku, w wierszach grup, panelu czlonkow, naglowku czatu i w
// ustawieniach rysowaly sie jako gole kolorowe kleksy, bez oczu i ust.
//
// Powod: geometria twarzy nie stoi w markupie. Atrybuty `d` oczu i ust pisze
// `draw()` w petli rAF, a petla zaczynala sie od `if (p.paused) return` — czyli
// dla `animated={false}` (a tak rysuje sie KAZDA statyczna maskotka w apce)
// `draw` nie wykonywal sie ani razu. Ponizej pilnujemy obu polowek warunku:
// pauza nadal maluje jedna klatke, a domyslka `showFace` zostaje wlaczona.
const dir = fileURLToPath(new URL(".", import.meta.url));
const blob = readFileSync(`${dir}BlobAvatar.tsx`, "utf8");
const avatar = readFileSync(`${dir}Avatar.tsx`, "utf8");

describe("statyczna maskotka ma twarz", () => {
  it("pauza nie wychodzi z petli przed rysowaniem", () => {
    // Goly `return` na pauzie to dokladnie ta regresja.
    expect(blob).not.toMatch(/if\s*\(p\.paused\)\s*return/);
    const branch = blob.match(/if\s*\(p\.paused\)\s*\{[\s\S]*?\n {8}\}/);
    expect(branch, "brak galezi `if (p.paused) { ... }` w petli klatek").toBeTruthy();
    expect(branch?.[0], "pauza musi wywolac draw(...) chocaz raz").toMatch(/\bdraw\(/);
  });

  it("twarz jest domyslnie wlaczona w obu warstwach", () => {
    expect(blob).toMatch(/showFace\s*=\s*true/);
    expect(avatar).toMatch(/showFace\s*=\s*true/);
  });

  it("awatar domyslnie patrzy prosto na uzytkownika", () => {
    expect(avatar).toMatch(/forward\s*=\s*true/);
    expect(avatar).toMatch(/const FORWARD_GAZE\s*=\s*\{\s*x:\s*0,\s*y:\s*0\s*\}/);
    expect(avatar).toMatch(/const restingGaze = forward \? FORWARD_GAZE : DEFAULT_GAZE/);
  });

  it("oczy i usta wisza pod przelacznikiem showFace", () => {
    expect(blob).toMatch(/\{showFace\s*&&\s*\(/);
    expect(blob).toMatch(/\{showMouth\s*&&\s*\(/);
  });

  it("nikt poza podgladem ksztaltu w ustawieniach nie gasi twarzy", () => {
    const files = readdirSync(dir).filter((name) => name.endsWith(".tsx"));
    const off = files.filter((name) =>
      /<BotAvatar(?![A-Za-z])[^>]*showFace=\{false\}/.test(readFileSync(`${dir}${name}`, "utf8")),
    );
    expect(off).toEqual(["SettingsPanel.tsx"]);
  });
});

// PR #52 zgubił też płynną zmianę kształtu: stary CursorAvatar interpolował
// ścieżkę przez flubber, BlobAvatar podmieniał sylwetkę z klatki na klatkę.
// Poniżej pilnujemy, że morf wrócił i że twarz jedzie razem z nim.
describe("zmiana kształtu morfuje, nie przeskakuje", () => {
  it("interpoluje sylwetkę przez flubber", () => {
    expect(blob).toContain("import { interpolate } from 'flubber'");
    expect(blob).toMatch(/interpolate\(faceDFor\(renderedShape\), faceDFor\(shape\)/);
  });

  it("rysuje ścieżkę przejściową zamiast osiadłego ciała", () => {
    expect(blob).toMatch(/morphD \? \(\s*<path d=\{morphD\} fill=\{paint\} \/>/);
    // Sylwetka i obszar przycięcia muszą iść tą samą ścieżką, inaczej twarz
    // przez pół morfa wystaje poza brzuch.
    expect(blob).toMatch(/<clipPath id=\{`\$\{uid\}-clip`\}>\s*<path d=\{morphD\} \/>/);
  });

  it("prowadzi kotwicę twarzy z kształtu do kształtu", () => {
    expect(blob).toContain("lerp(morphFrom.current.x, morphTo.current.x, morphT)");
    expect(blob).toContain("anchorTransform(anchorNow)");
  });
});

describe("static avatar pointer follow", () => {
  it("supports paused hover follow and resets gaze on leave", () => {
    expect(avatar).toContain("trackPointerWhenPaused?: boolean;");
    expect(avatar).toContain("const pointerFollow = trackPointer && (animated || trackPointerWhenPaused);");
    expect(avatar).toContain("const onPointerLeave = () => setPointer({ x: 0, y: 0 });");
    expect(avatar).toContain("onPointerLeave={pointerFollow ? onPointerLeave : undefined}");
  });
});
