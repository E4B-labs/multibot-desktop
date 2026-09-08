import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { remarkBrackets } from "./brackets";
import { remarkSkillRefs } from "./skillRefs";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const peerBadge = source("../components/PeerBadge.tsx");
const chatMarkdown = source("../components/ChatMarkdown.tsx");
const chatView = source("../components/ChatView.tsx");
const roomPanel = source("../components/RoomPanel.tsx");
const groupPanel = source("../components/GroupPanel.tsx");

// multibot: wygląd wiadomości ma być JEDEN, niezależnie od widoku. Dotąd te
// same kawałki miały po dwie kopie i rozjeżdżały się po kolei:
//   - pigułka bota: własny markup w ChatMarkdown (wzmianka `@Nazwa`) i drugi,
//     identyczny, w PeerBadge (nadawca koperty bot→bot w dymku „user"),
//   - wypowiedź bota: `compact` w czacie i w grupie, ale NIE w widoku pokoju,
//     więc ta sama wiadomość była tam większa.
// Vitest chodzi tu bez DOM-u, więc pilnujemy tego na źródle.
describe("jeden wygląd wiadomości we wszystkich widokach", () => {
  it("pigułka bota ma jeden komponent i jeden zestaw klas", () => {
    expect(peerBadge).toContain("export const BOT_CHIP_CLASS");
    expect(peerBadge).toContain("export function BotChip");
    // Klasy owalu istnieją dokładnie raz w całym kodzie — w PeerBadge.tsx.
    for (const [name, code] of [["ChatMarkdown", chatMarkdown], ["ChatView", chatView]] as const) {
      expect(code, `${name} znowu ma własną kopię klas pigułki bota`).not.toContain(
        "rounded-full bg-raised px-2 py-0.5 align-middle",
      );
    }
  });

  it("wzmianka w markdownie i plakietka nadawcy to ten sam komponent", () => {
    expect(chatMarkdown).toContain('import { BotChip } from "./PeerBadge";');
    expect(chatMarkdown).toContain("<BotChip bot={bot} />");
    expect(peerBadge).toContain("<BotChip bot={bot} className=\"mr-1.5\" />");
    expect(chatView).toContain("<PeerBadge name={envelope.from} />");
  });

  it("czat, grupa i pokój renderują wypowiedź bota tym samym markdownem", () => {
    for (const [name, code] of [["ChatView", chatView], ["GroupPanel", groupPanel], ["RoomPanel", roomPanel]] as const) {
      expect(code, `${name} renderuje ChatMarkdown bez compact`).toMatch(/<ChatMarkdown[^>]*\scompact\b/);
    }
    // Ten sam dymek: padding i interlinia z ChatView.
    for (const [name, code] of [["GroupPanel", groupPanel], ["RoomPanel", roomPanel]] as const) {
      expect(code, `${name} ma inny dymek niż czat`).toContain("bg-card px-2 py-[5px] text-[14px] leading-[1.45]");
    }
  });

  it("karta aktywności bot↔bot i czip pokoju wchodzą do pokoju tym samym helperem", () => {
    expect(chatView).toContain("function openRoom(");
    expect((chatView.match(/openRoom\(room\.id, dispatch\)/g) ?? []).length).toBe(2);
  });
});

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
