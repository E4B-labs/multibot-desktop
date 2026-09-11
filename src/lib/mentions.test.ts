import { describe, expect, it } from "vitest";
import remarkGfm from "remark-gfm";
import { mentionPlugins, mentionRegex, remarkMentions, splitMentions } from "./mentions";

const bots = [{ name: "Content Agent" }, { name: "New Bot" }];

/** To, co robi unified z listą wtyczek: krotka rozkłada się na atacher i opcje. */
function runPlugins(list: unknown[], tree: any) {
  for (const entry of list) {
    const [attacher, options] = Array.isArray(entry) ? entry : [entry, undefined];
    if (attacher === remarkGfm) continue; // gfm wymaga prawdziwego procesora
    const transformer = (attacher as (o: any) => any)(options);
    transformer(tree);
  }
  return tree;
}

const paragraph = (value: string) => ({ type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] });
const kinds = (tree: any) => tree.children[0].children.map((c: any) => c.type);
const mentionNames = (tree: any) =>
  tree.children[0].children.filter((c: any) => c.type === "mention").map((c: any) => c.data.hProperties.dataMention);

describe("wzmianki @bot", () => {
  it("przechodzi przez listę wtyczek tak, jak wywoła ją unified", () => {
    // Regres: lista miała `remarkMentions({ bots })`, więc unified dostawał
    // gotowy transformer i odpalał go jako atacher, bez drzewa — cała
    // aplikacja padała na starcie z „Cannot read properties of undefined".
    const tree = runPlugins(mentionPlugins(remarkGfm, bots), paragraph("hej @New Bot zrób to"));
    expect(kinds(tree)).toEqual(["text", "mention", "text"]);
    expect(mentionNames(tree)).toEqual(["New Bot"]);
  });

  it("bez botów nie dokłada wtyczki wzmianek", () => {
    expect(mentionPlugins(remarkGfm, [])).toEqual([remarkGfm]);
  });

  it("łapie wzmiankę na początku i kilka w jednym zdaniu", () => {
    const tree = paragraph("@Content Agent i @New Bot razem");
    remarkMentions({ bots })(tree);
    expect(mentionNames(tree)).toEqual(["Content Agent", "New Bot"]);
  });

  it("nie tyka adresu pocztowego ani nazwy z myślnikiem", () => {
    const tree = paragraph("pisz na ktos@New Bot-owy.pl, nie tutaj");
    remarkMentions({ bots })(tree);
    expect(kinds(tree)).toEqual(["text"]);
  });

  it("nie używa lookbehind — starsze WebView Androida rzucają na nim SyntaxError", () => {
    // Wzorzec żyje od K2 w `mentionRegex`, więc sprawdzamy jego źródło —
    // `String(remarkMentions(...))` przestałoby cokolwiek znaczyć.
    expect(String(mentionRegex(bots)).includes("(?<")).toBe(false);
    expect(String(mentionRegex).includes("(?<")).toBe(false);
  });
});

// multibot K2: ten sam tokenizer karmi warstwę podświetlenia w composerze.
// Warunek, na którym stoi cała warstwa: sklejone `text` = dokładnie wejście.
describe("splitMentions", () => {
  const parts = (value: string) => splitMentions(value, bots);
  const joined = (value: string) => parts(value).map((p) => p.text).join("");

  it("zwraca segmenty, których suma to wejście co do znaku", () => {
    for (const value of ["", "@New Bot", "hej @New Bot!", "a@b", "@New Bot @Content Agent", "  @New\n@New Bot "]) {
      expect(joined(value)).toBe(value);
    }
  });

  it("znaczy wzmiankę surowym tekstem i nazwą bota", () => {
    expect(parts("hej @New Bot!")).toEqual([
      { text: "hej " },
      { text: "@New Bot", name: "New Bot" },
      { text: "!" },
    ]);
  });

  it("dłuższe imię wygrywa z krótszym prefiksem", () => {
    const longer = [{ name: "New" }, { name: "New Bot" }];
    expect(splitMentions("@New Bot", longer)).toEqual([{ text: "@New Bot", name: "New Bot" }]);
  });

  it("nie tyka nieznanego imienia ani niedokończonego pisania", () => {
    expect(parts("@Nikt")).toEqual([{ text: "@Nikt" }]);
    expect(parts("@New B")).toEqual([{ text: "@New B" }]);
    expect(parts("@")).toEqual([{ text: "@" }]);
  });

  it("nie tyka adresu pocztowego", () => {
    expect(parts("pisz na ktos@New Bot.pl")).toEqual([{ text: "pisz na ktos@New Bot.pl" }]);
  });

  it("pusta lista botów zwraca jeden segment", () => {
    expect(splitMentions("@New Bot", [])).toEqual([{ text: "@New Bot" }]);
  });
});

// Bot bez nazwy dawał pustą alternatywę w regexie, czyli wzmiankę z samego „@" —
// w composerze gołe „@" robiło się pigułką, zanim cokolwiek napisano.
describe("bot bez nazwy", () => {
  it("nie zamienia gołego @ we wzmiankę", () => {
    expect(splitMentions("napisz @ tutaj", [{ name: "" }])).toEqual([{ text: "napisz @ tutaj" }]);
    expect(splitMentions("@ i @New Bot", [{ name: "" }, { name: "New Bot" }])).toEqual([
      { text: "@ i " },
      { text: "@New Bot", name: "New Bot" },
    ]);
  });
});

// multibot K2 (recenzja PR #185, HIGH): klient MUSI rozpoznawać wzmiankę tak
// samo jak `mentionedBots` w `server/store.ts` — to serwer decyduje, kto
// naprawdę zostanie ztagowany, więc pigułka nad nazwą, której serwer nie
// rozpozna, kłamie. Roster i przypadki 1:1 z `server/comms.test.ts`
// („mentionedBots"). Nie importujemy tamtej funkcji: `server/store.ts` ciągnie
// `config.ts`, który przy wczytaniu tworzy katalog danych.
describe("parytet z mentionedBots na serwerze", () => {
  const roster = [
    { name: "New Bot" },
    { name: "New Bot 2" },
    { name: "Milind" },
    { name: "Ghost", hidden: true },
    { name: "   " },
  ];
  const hits = (value: string) => splitMentions(value, roster).filter((p) => p.name).map((p) => p.name);

  it("łapie tag na początku słowa, bez względu na wielkość liter", () => {
    expect(hits("hey @milind, look")).toEqual(["milind"]);
    expect(hits("@Milind first thing")).toEqual(["Milind"]);
  });

  it("dłuższa nazwa wygrywa, więc prefiks nigdy nie trafia połowicznie", () => {
    expect(hits("ask @New Bot 2 about it")).toEqual(["New Bot 2"]);
  });

  it("łapie kilka wzmianek w jednym zdaniu", () => {
    // Serwer deduplikuje (raz tagguje bota na wiadomość), klient NIE: każde
    // wystąpienie ma dostać pigułkę. Parytet dotyczy tego, CO jest wzmianką,
    // nie tego, ile razy bot zostanie obudzony.
    expect(hits("@Milind and @New Bot and @Milind")).toEqual(["Milind", "New Bot", "Milind"]);
  });

  it("pomija adresy pocztowe, boty ukryte i nazwy ze spacji", () => {
    expect(hits("mail milind@milind.dev please")).toEqual([]);
    expect(hits("@Ghost around?")).toEqual([]);
    expect(hits("@    tutaj")).toEqual([]);
  });

  it("przed @ musi stać BIAŁY znak — nie dowolny nie-wyrazowy", () => {
    // serwer: `if (at > 0 && !/\s/.test(text[at - 1])) continue`
    expect(hits("(@Milind)")).toEqual([]);
    expect(hits("x-@Milind")).toEqual([]);
    expect(hits("napisz\n@Milind")).toEqual(["Milind"]);
  });

  it("po nazwie NIE MA granicy — serwer używa startsWith", () => {
    // `@New Bots` u serwera tagguje „New Bot"; lookahead `(?![\w-])` dawał tu
    // wcześniej brak pigułki tam, gdzie tag realnie działał.
    expect(hits("@New Bots zrobia to")).toEqual(["New Bot"]);
    expect(hits("@Milind-owy raport")).toEqual(["Milind"]);
  });
});

// Jednoelementowy cache wzorca: composer woła to przy każdym znaku.
describe("cache mentionRegex", () => {
  it("oddaje ten sam obiekt dla tego samego rosteru i nowy po zmianie", () => {
    const a = mentionRegex([{ name: "Ala" }, { name: "Borys" }]);
    expect(mentionRegex([{ name: "Ala" }, { name: "Borys" }])).toBe(a);
    // ukryty bot wypada z kandydatów, więc wzorzec musi się przeliczyć
    expect(mentionRegex([{ name: "Ala" }, { name: "Borys", hidden: true }])).not.toBe(a);
  });

  it("wspólny wzorzec nie przenosi lastIndex miedzy wywołaniami", () => {
    const bots2 = [{ name: "Ala" }];
    expect(splitMentions("@Ala i @Ala", bots2).filter((p) => p.name)).toHaveLength(2);
    // drugie wywołanie na krótszym tekście musi zaczynać od zera
    expect(splitMentions("@Ala", bots2)).toEqual([{ text: "@Ala", name: "Ala" }]);
  });
});
