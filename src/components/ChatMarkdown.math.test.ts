// multibot: matematyka w dymkach — dwa poziomy sprawdzenia.
//
// 1. Zachowanie: ten sam potok co w ChatMarkdown (react-markdown + remark-math
//    + rehype-katex) przepuszczony przez `renderToStaticMarkup`. Vitest chodzi
//    w env `node`, ale `react-dom/server` DOM-u nie potrzebuje.
// 2. Źródło: w zbudowanym interfejsie nie ma prawa być odwołania do CDN-a
//    z arkuszem albo fontami KaTeX — webui jedzie na telefon jako jeden string
//    HTML i chodzi przez Tora, więc zewnętrzny host to pusty kwadrat.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { describe, expect, it } from "vitest";

const render = (text: string) =>
  renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [[rehypeKatex, { output: "mathml", throwOnError: false, strict: false }] as any],
      children: text,
    }),
  );

describe("chat markdown math pipeline", () => {
  it("renders inline $x^2$ as MathML", () => {
    const html = render("energy is $x^2$ here");
    expect(html).toContain("<math");
    expect(html).toContain("msup");
  });

  it("renders a $$…$$ display block", () => {
    // display = `$$` w osobnych wierszach; jednolinijkowe `$$…$$` rozbija
    // `normalizeDisplayMath` z `@/lib/asciiMath` (test tam)
    const html = render("$$\n\\frac{a}{b} = c\n$$");
    expect(html).toContain("<math");
    // w trybie mathml KaTeX NIE opakowuje bloku w `.katex-display` — jedyny
    // uchwyt dla CSS to `display="block"` na samym <math>, i tak celuje styl
    // w ChatMarkdown. Ten test pilnuje, żeby ten uchwyt nie zniknął.
    expect(html).toContain('display="block"');
    expect(html).not.toContain("katex-display");
  });

  it("renders math inside list items", () => {
    const html = render("1. first $a^{-n}$\n2. second $b^2$");
    expect(html).toContain("<ol");
    expect((html.match(/<math/g) ?? []).length).toBe(2);
  });

  it("does not throw on broken LaTeX", () => {
    expect(() => render("$\\frac{$")).not.toThrow();
    expect(() => render("$$\\begin{matrix}$$")).not.toThrow();
    expect(render("$\\frac{$")).toBeTruthy();
  });

  it("emits no KaTeX HTML-mode font spans in mathml output", () => {
    // tryb `mathml` nie rysuje wzoru <span>-ami, więc fonty KaTeX są zbędne
    expect(render("$x^2$")).not.toContain("katex-html");
  });
});

describe("no external KaTeX assets", () => {
  const sources = [
    "src/components/ChatMarkdown.tsx",
    "src/main.tsx",
    "src/styles.css",
    "index.html",
  ].map((path) => [path, readFileSync(path, "utf8")] as const);

  it("never references a CDN or a KaTeX stylesheet", () => {
    for (const [path, source] of sources) {
      expect(source, path).not.toMatch(/cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare|fonts\.googleapis|fonts\.gstatic/);
      expect(source, path).not.toMatch(/katex(?:\.min)?\.css/);
      expect(source, path).not.toMatch(/KaTeX_[A-Za-z]+/);
    }
  });

  it("asks rehype-katex for MathML and never throws", () => {
    const markdown = sources.find(([p]) => p.endsWith("ChatMarkdown.tsx"))![1];
    expect(markdown).toContain('output: "mathml"');
    expect(markdown).toContain("throwOnError: false");
  });
});
