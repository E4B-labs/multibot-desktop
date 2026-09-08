import { describe, expect, it } from "vitest";

import { remarkBrackets } from "./brackets";
import { remarkSkillRefs } from "./skillRefs";

const root = (child: any) => ({ type: "root", children: [{ type: "paragraph", children: [child] }] });
const children = (tree: any) => tree.children[0].children;

describe("quoted bracket formatting", () => {
  it("renders quoted brackets as italic and leaves bare brackets alone", () => {
    const quoted = root({ type: "text", value: "before '[text]' after" });
    remarkBrackets()(quoted);
    expect(children(quoted)).toEqual([
      { type: "text", value: "before " },
      { type: "emphasis", children: [{ type: "text", value: "text" }] },
      { type: "text", value: " after" },
    ]);

    const bare = root({ type: "text", value: "[text]" });
    remarkBrackets()(bare);
    expect(children(bare)).toEqual([{ type: "text", value: "[text]" }]);
  });

  it("renders markdown-wrapped quoted brackets as bold", () => {
    const tree = root({ type: "emphasis", children: [{ type: "text", value: "'[text]'" }] });
    remarkBrackets()(tree);
    expect(children(tree)).toEqual([
      { type: "strong", children: [{ type: "text", value: "text" }] },
    ]);
  });
});

describe("skill references", () => {
  it("marks every known skill name without matching inside another word", () => {
    const tree = root({ type: "text", value: "Use Grill Me, C++ Review and preGrill Me." });
    remarkSkillRefs({ skills: ["Grill Me", "C++ Review"] })(tree);
    const refs = children(tree)
      .filter((node: any) => node.type === "skillRef")
      .map((node: any) => node.data.hProperties.dataSkillRef);
    expect(refs).toEqual(["Grill Me", "C++ Review"]);
  });
  it("łapie nazwę w polskich cudzysłowach, tak jak bot ją pisze w zdaniu", () => {
    // Zdanie prosto z czatu: „Umiejętność „Grill Me" została utworzona…".
    // Cudzysłów typograficzny musi liczyć się jako granica słowa, inaczej
    // pigułka nie powstaje dokładnie tam, gdzie użytkownik jej oczekuje.
    const tree = root({ type: "text", value: "Umiejętność „Grill Me” została utworzona i będę jej używać." });
    remarkSkillRefs({ skills: ["Grill Me"] })(tree);
    const refs = children(tree)
      .filter((node: any) => node.type === "skillRef")
      .map((node: any) => node.data.hProperties.dataSkillRef);
    expect(refs).toEqual(["Grill Me"]);
  });
  it("zamienia znany skill w backtickach na pigułkę, obcego kodu nie rusza", () => {
    // Bot pisze „…: skill weryfikacja-premier-modeli-ai je…" w backtickach —
    // czarna pigułka kodu wcinała się w zdanie zamiast żółtej nazwy.
    const tree = root({ type: "inlineCode", value: "skill weryfikacja-premier-modeli-ai" });
    remarkSkillRefs({ skills: ["weryfikacja-premier-modeli-ai"] })(tree);
    expect(children(tree)).toEqual([
      { type: "text", value: "skill " },
      {
        type: "skillRef",
        data: { hName: "span", hProperties: { dataSkillRef: "weryfikacja-premier-modeli-ai" } },
        children: [{ type: "text", value: "weryfikacja-premier-modeli-ai" }],
      },
    ]);

    const other = root({ type: "inlineCode", value: "npm run build" });
    remarkSkillRefs({ skills: ["weryfikacja-premier-modeli-ai"] })(other);
    expect(children(other)).toEqual([{ type: "inlineCode", value: "npm run build" }]);
  });
  it("nie rusza bloku kodu", () => {
    const tree = { type: "root", children: [{ type: "code", value: "Grill Me" }] };
    remarkSkillRefs({ skills: ["Grill Me"] })(tree);
    expect(tree.children).toEqual([{ type: "code", value: "Grill Me" }]);
  });
});
