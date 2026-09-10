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

  it("bez nagłówka nazwa idzie z nazwy pliku, bez rozszerzenia i ścieżki", () => {
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

  it("CRLF i BOM nie psują rozbioru", () => {
    const parsed = parseSkillFile("x.md", "\ufeff---\r\nname: crlf\r\n---\r\nZrób coś.\r\n");
    expect(parsed.name).toBe("crlf");
    expect(parsed.instructions).toBe("Zrób coś.");
  });

  it("nazwa dłuższa niż limit serwera (80) jest przycinana", () => {
    const parsed = parseSkillFile("x.md", `---\nname: ${"a".repeat(120)}\n---\ntreść`);
    expect(parsed.name).toHaveLength(80);
  });
});
