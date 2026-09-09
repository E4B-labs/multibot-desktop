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

  it("sledzi kursor rowniez jako nieruchomy awatar", () => {
    expect(avatar).toMatch(/if \(!trackPointer\) return/);
    expect(avatar).toMatch(/onPointerDown=\{trackPointer \? onPointerDown : undefined\}/);
    expect(avatar).toMatch(/onPointerMove=\{trackPointer \? onPointerMove : undefined\}/);
    expect(avatar).toMatch(/onPointerUp=\{trackPointer \? onPointerUp : undefined\}/);
    expect(avatar).toMatch(/onPointerCancel=\{trackPointer \? onPointerUp : undefined\}/);
    expect(avatar).toMatch(/onLostPointerCapture=\{trackPointer \? onLostPointerCapture : undefined\}/);
    expect(avatar).toMatch(/onPointerLeave=\{trackPointer \? onPointerLeave : undefined\}/);
  });

  it("oczy i usta wisza pod przelacznikiem showFace", () => {
    expect(blob).toMatch(/\{showFace\s*&&\s*\(/);
    expect(blob).toMatch(/\{showMouth\s*&&\s*\(/);
  });

  it("nikt poza podgladem ksztaltu w ustawieniach nie gasi twarzy", () => {
    const files = readdirSync(dir).filter((name) => name.endsWith(".tsx"));
    const off = files.filter((name) =>
      /<MausAvatar(?![A-Za-z])[^>]*showFace=\{false\}/.test(readFileSync(`${dir}${name}`, "utf8")),
    );
    expect(off).toEqual(["SettingsPanel.tsx"]);
  });
});
