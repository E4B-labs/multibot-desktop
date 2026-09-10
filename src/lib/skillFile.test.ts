import { describe, expect, it } from "vitest";
import { parseSkillFile } from "./skillFile";

describe("parseSkillFile", () => {
  it("bierze nazwę i opis z front-matteru, resztę jako instrukcje", () => {
    const parsed = parseSkillFile("whatever.md", [
      "---",
      "name: deploy-web",
      'description: "wypuszcza stronę na produkcję"',
      "---",
      "# Deploy",
      "",
      "1. zbuduj",
    ].join("\n"));
    expect(parsed.name).toBe("deploy-web");
    expect(parsed.description).toBe("wypuszcza stronę na produkcję");
    expect(parsed.instructions).toBe("# Deploy\n\n1. zbuduj");
  });

  it("bez front-matteru nazwa idzie z pierwszego nagłówka", () => {
    const parsed = parseSkillFile("skill.md", "## Reset routera\n\nWyciągnij wtyczkę.");
    expect(parsed.name).toBe("Reset routera");
    expect(parsed.description).toBe("Wyciągnij wtyczkę.");
  });

  it("bez nagłówka nazwa idzie z nazwy pliku, bez rozszerzenia", () => {
    const parsed = parseSkillFile("morning-report.markdown", "Zbierz metryki i wyślij.");
    expect(parsed.name).toBe("morning-report");
    expect(parsed.instructions).toBe("Zbierz metryki i wyślij.");
  });

  it("plik skill.md bez nagłówka to za mało na nazwę", () => {
    expect(() => parseSkillFile("skill.md", "same instrukcje")).toThrow(/no skill name/);
  });

  it("pusty plik leci błędem", () => {
    expect(() => parseSkillFile("pusty.md", "   \n\n")).toThrow(/empty/);
  });

  it("sam front-matter bez treści leci błędem, nie skillem z YAML-a w środku", () => {
    expect(() => parseSkillFile("x.md", "---\nname: solo\n---\n")).toThrow(/no instructions/);
  });

  // Regresja: kreska pozioma na górze pliku wyglądała jak front-matter i cała
  // treść do NASTĘPNEJ kreski znikała bez ostrzeżenia.
  it("kreska pozioma na górze pliku to nie front-matter — treść zostaje", () => {
    const parsed = parseSkillFile("notatki.md", [
      "---",
      "",
      "# Reset routera",
      "",
      "Wyciągnij wtyczkę.",
      "",
      "---",
      "",
      "Potem włóż z powrotem.",
    ].join("\n"));
    expect(parsed.name).toBe("Reset routera");
    expect(parsed.instructions).toContain("Wyciągnij wtyczkę.");
    expect(parsed.instructions).toContain("Potem włóż z powrotem.");
  });

  it("CRLF i BOM znikają też z wieloliniowych instrukcji", () => {
    const parsed = parseSkillFile(
      "x.md",
      "﻿---\r\nname: crlf\r\n---\r\nPierwszy wiersz.\r\nDrugi wiersz.\r\n",
    );
    expect(parsed.name).toBe("crlf");
    expect(parsed.instructions).toBe("Pierwszy wiersz.\nDrugi wiersz.");
  });

  it("blok `|` daje pusty opis, nie literalną kreskę pionową", () => {
    const parsed = parseSkillFile("x.md", "---\nname: blok\ndescription: |\n  dwa\n  wiersze\n---\nTreść.");
    expect(parsed.description).toBe("Treść.");
  });

  it("komentarz na końcu niecytowanej wartości nie wchodzi do nazwy", () => {
    const parsed = parseSkillFile("x.md", "---\nname: deploy # tylko produkcja\n---\nTreść.");
    expect(parsed.name).toBe("deploy");
  });

  it("zamykające krzyżyki nagłówka nie wchodzą do nazwy", () => {
    expect(parseSkillFile("x.md", "# Tytuł #\n\nTreść.").name).toBe("Tytuł");
  });

  it("nazwa dłuższa niż limit serwera (80) jest przycinana", () => {
    const parsed = parseSkillFile("x.md", `---\nname: ${"a".repeat(120)}\n---\ntreść`);
    expect(parsed.name).toHaveLength(80);
  });

  it("przycięcie nazwy nie rozcina emoji w pół", () => {
    // 79 znaków + emoji: cięcie na 80 trafiłoby w środek pary surogatów
    const parsed = parseSkillFile("x.md", `---\nname: ${"a".repeat(79)}😀\n---\ntreść`);
    expect(parsed.name).toBe("a".repeat(79));
    expect(parsed.name).not.toMatch(/[\uD800-\uDBFF]/);
  });

  it("opis dłuższy niż limit serwera (2000) jest przycinany", () => {
    const parsed = parseSkillFile("x.md", `---\ndescription: ${"b".repeat(2_500)}\nname: x\n---\ntreść`);
    expect(parsed.description).toHaveLength(2_000);
  });
});
