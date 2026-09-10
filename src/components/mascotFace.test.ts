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

describe("static avatar pointer follow", () => {
  it("supports paused hover follow and resets gaze on leave", () => {
    expect(avatar).toContain("trackPointerWhenPaused?: boolean;");
    expect(avatar).toContain("const pointerFollow = trackPointer && (animated || trackPointerWhenPaused);");
    expect(avatar).toContain("const onPointerLeave = () => setPointer({ x: 0, y: 0 });");
    expect(avatar).toContain("onPointerLeave={pointerFollow && !scoped ? onPointerLeave : undefined}");
  });

  // multibot: scope śledzenia — buźka podąża za kursorem po całym oznaczonym
  // kontenerze (np. hover-wiersz bota w sidebarze), nie tylko nad awatarem.
  it("follows the pointer across a data-mb-avatar-scope container", () => {
    // Scope znajduje się przez closest() od spana awatara…
    expect(avatar).toContain('closest<HTMLElement>("[data-mb-avatar-scope]")');
    // …słucha natywnie na kontenerze i sprząta po sobie.
    expect(avatar).toContain('scope.addEventListener("pointermove", onMove);');
    expect(avatar).toContain('scope.addEventListener("pointerleave", onLeave);');
    expect(avatar).toContain('scope.removeEventListener("pointermove", onMove);');
    expect(avatar).toContain('scope.removeEventListener("pointerleave", onLeave);');
    // Gaze od ŚRODKA awatara, znormalizowany do ±1 na krawędziach scope'a.
    expect(avatar).toContain("const cx = rect.left + rect.width / 2;");
    expect(avatar).toContain("x: Math.max(-1, Math.min(1, (event.clientX - cx) / spanX)) * range,");
    // Wyjście kursora ze scope'a wraca do spojrzenia na wprost.
    expect(avatar).toContain('const onLeave = () => setPointer({ x: 0, y: 0 });');
    // W scope handlery na spanie milkną — śledzi tylko kontener.
    expect(avatar).toContain("onPointerMove={pointerFollow && !scoped ? onPointerMove : undefined}");
    // Bez scope'a zostaje stare zachowanie na spanie awatara.
    expect(avatar).toContain("const onPointerMove = (event: ReactPointerEvent<HTMLSpanElement>) => {");
  });
});
