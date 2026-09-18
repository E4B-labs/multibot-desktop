import { describe, expect, it } from "vitest";
import { asciiMathToLatex } from "./asciiMath";

describe("asciiMathToLatex", () => {
  it("wraps ASCII exponent laws", () => {
    expect(asciiMathToLatex("a^(-n) = 1/a^n")).toBe("$a^{-n} = 1/a^n$");
    expect(asciiMathToLatex("a^x * a^y = a^(x+y)")).toBe("$a^x \\cdot a^y = a^{x+y}$");
    expect(asciiMathToLatex("(1/2)^√3")).toBe("$(1/2)^\\sqrt{3}$");
    expect(asciiMathToLatex("5^(2x-1) = 1/125")).toBe("$5^{2x-1} = 1/125$");
  });

  it("keeps list markers outside the math", () => {
    const out = asciiMathToLatex("1. a^(-n) = 1/a^n\nb) 5^(2x-1) = 1/125");
    expect(out).toBe("1. $a^{-n} = 1/a^n$\nb) $5^{2x-1} = 1/125$");
  });

  it("wraps a formula that follows a colon", () => {
    expect(asciiMathToLatex("So we get: 5^(2x-1) = 1/125")).toBe("So we get: $5^{2x-1} = 1/125$");
  });

  it("converts sqrt(...)", () => {
    expect(asciiMathToLatex("sqrt(x+1) = 2^k")).toBe("$\\sqrt{x+1} = 2^k$");
  });

  it("leaves prose, paths, URLs and code alone", () => {
    for (const negative of [
      "C:\\path\\to^file",
      "a/b testing is how we ship",
      "2^32-bit addressing",
      "See https://example.com/a/b for details",
      "Split the work a/b and move on to the next thing",
      "The ratio was 3/4 of the total budget last quarter",
      "config/app.yml",
    ]) {
      expect(asciiMathToLatex(negative)).toBe(negative);
    }
  });

  it("never touches fenced or inline code", () => {
    const src = "```\na^(-n) = 1/a^n\n```\nand `5^(2x-1) = 1/125` inline";
    expect(asciiMathToLatex(src)).toBe(src);
  });

  it("promotes a one-line $$…$$ to a display block", () => {
    expect(asciiMathToLatex("$$a^2 + b^2 = c^2$$")).toBe("$$\na^2 + b^2 = c^2\n$$");
    expect(asciiMathToLatex("text $$x$$ more")).toBe("text $$x$$ more");
  });

  it("is a no-op when the text already carries LaTeX", () => {
    const src = "Already good: $a^{-n} = 1/a^n$ and 2^(x+1) = 8";
    expect(asciiMathToLatex(src)).toBe(src);
  });
});
