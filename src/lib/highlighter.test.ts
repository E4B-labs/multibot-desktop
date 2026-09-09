import { describe, expect, it } from "vitest";
import { highlightCode } from "./highlighter";

// Cały sens tego pliku: lista języków w highlighter.ts jest ręczna, a pomyłka
// w nazwie nie wywraca buildu — kolorowanie po prostu cicho znika i zostaje
// goły <pre>. Tu pomyłka pada.
describe("highlightCode", () => {
  it("koloruje języki z listy, także po aliasach", async () => {
    for (const lang of ["typescript", "js", "py", "sh", "bash", "md", "json", "yaml", "diff", "dockerfile"]) {
      const html = await highlightCode("const x = 1", lang);
      expect(html, lang).toContain("<pre");
    }
  });

  it("rzuca na języku spoza listy — wołający zostawia wtedy zwykły <pre>", async () => {
    await expect(highlightCode("10 PRINT", "basic")).rejects.toThrow();
  });
});
