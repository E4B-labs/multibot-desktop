import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: dymek gotowej wiadomości i dymek strumieniowany muszą mieć TĘ SAMĄ
// szerokość — inaczej tekst przeskakuje w chwili, gdy strumień się kończy
// i jeden komponent podmienia drugi. Zależność była opisana komentarzem
// w StreamingBubble, ale nikt jej nie pilnował: przy poszerzaniu dymków
// 29.08 (35% → 90%) drugie miejsce zostało w tyle. Stąd ten test.
const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const roomPanel = readFileSync(new URL("./RoomPanel.tsx", import.meta.url), "utf8");

// Vitest działa tu bez DOM, więc integrację ChatView → Composer sprawdzamy na
// źródle; sama reguła aktualizacji mapy ma test wykonawczy w Composer.test.ts.
describe("drafty wiadomości per bot", () => {
  it("przekazuje Composerowi draft aktywnego bota i callback zapisujący po jego id", () => {
    expect(chat).toContain("const [drafts, setDrafts] = useState<Record<string, string>>({});");
    expect(chat).toContain("setBotDraft(current, bot.id, text)");
    expect(chat).toContain('<Composer bot={bot} draft={drafts[bot.id] ?? ""} onDraftChange={setDraft} />');
  });
});

/** Linie, które opisują sam dymek (mają zaokrąglenie 2xl).
 *  Samo zaokraglenie nie wystarcza: ma je tez podglad ekranu bota,
 *  ktory dymkiem nie jest. Padding py-[5px] maja tylko oba dymki. */
function bubbleLines(): string[] {
  return chat
    .split(/\r?\n/)
    .filter((line) => line.includes("rounded-2xl") && line.includes("py-[5px]"));
}

/** Szerokości z linii, które opisują sam dymek. */
function bubbleWidths(): string[] {
  const out: string[] = [];
  for (const line of bubbleLines()) {
    if (!line.includes("max-w-[")) continue;
    const at = line.indexOf("max-w-[") + "max-w-[".length;
    out.push(line.slice(at, line.indexOf("]", at)));
  }
  return out;
}

describe("szerokość dymków czatu", () => {
  it("dymek zwykły i strumieniowany mają tę samą szerokość", () => {
    const widths = bubbleWidths();
    expect(widths.length, "nie znalazłem szerokości dymków").toBeGreaterThanOrEqual(2);
    expect(new Set(widths).size, `rozjechane szerokości dymków: ${widths.join(", ")}`).toBe(1);
  });

  it("dymek jest szeroki, nie zwężony do jednej trzeciej", () => {
    expect(Number.parseInt(bubbleWidths()[0], 10)).toBeGreaterThanOrEqual(80);
  });

  // multibot: `max-w-` to sufit, nie szerokość — dymek jest elementem flexa,
  // więc kurczy się do treści i jednoliniowa odpowiedź bota („Sesja wygasła,
  // loguję się ponownie.") zajmuje tyle, ile potrzebuje. `w-full` w tej samej
  // klasie zamienia sufit w szerokość na sztywno i każdy dymek staje się
  // pasem na całą kolumnę. Mobilna kopia webui zrobiła dokładnie to (Kacper
  // 08.09, zrzut z telefonu), stąd strażnik po tej stronie.
  it("dymek ma sufit szerokości, a nie sztywną pełną szerokość", () => {
    const lines = bubbleLines();
    expect(lines.length, "nie znalazłem linii dymków").toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line, `dymek bez sufitu szerokości: ${line.trim()}`).toContain("max-w-[");
      // `\b` nie wystarcza: w `max-w-full` przed „w" też stoi granica słowa.
      expect(line, `dymek przypięty do pełnej szerokości: ${line.trim()}`).not.toMatch(/(?<![-\w])w-full\b/);
    }
  });
});

// multibot: awatar w pasku nad rozmową ma stać nieruchomo, gdy bot nie
// pracuje. Wcześniej MausAvatar size 40 dostawał gołe `animated` plus
// jednorazowy beat z `state.mascotMotion`, więc bezczynny bot mrugał
// i oddychał, choć ten sam bot w pasku bocznym już stał.
describe("awatar w nagłówku czatu", () => {
  it("nie jest animowany na sztywno", () => {
    expect(chat, "nagłówek wrócił do `animated` bez warunku").not.toMatch(/^\s*animated\s*$/m);
    expect(chat, "nagłówek znowu odtwarza jednorazowy state.mascotMotion").not.toContain(
      "state.mascotMotion",
    );
  });

  it("liczy propsy tym samym helperem co pasek boczny", () => {
    expect(chat).toContain("sidebarAvatarProps(bot)");
    expect(chat).toContain("animated={headerAvatar.animated}");
  });
});

// multibot: poziomy pasek przewijania w czacie i biały kwadracik w jego prawym
// końcu. Dymek jest elementem flexa, więc `min-width:auto` nie pozwalał mu
// zejść poniżej szerokości min-content — jeden długi token bez spacji rozpychał
// wiersz poza listę. Narożnik paska Chrome domyślnie maluje na BIAŁO, gdy
// jakikolwiek `::-webkit-scrollbar` jest ostylowany.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("czat nie przewija się w bok", () => {
  it("oba dymki kurczą się i łamią długie tokeny", () => {
    const bubbles = chat
      .split(/\r?\n/)
      .filter((line) => line.includes("rounded-2xl") && line.includes("py-[5px]") && line.includes("max-w-["));
    expect(bubbles.length).toBeGreaterThanOrEqual(2);
    for (const line of bubbles) {
      expect(line, `dymek bez min-w-0: ${line.trim()}`).toContain("min-w-0");
      expect(line, `dymek bez break-words: ${line.trim()}`).toContain("break-words");
    }
  });

  it("lista wiadomości ma oddech pod ostatnim dymkiem", () => {
    expect(chat).toContain('className="flex w-full min-w-0 flex-col gap-1 pb-16"');
  });

  /** Ciało JEDNEJ reguły CSS: od selektora do najbliższej klamry zamykającej.
   *  Bez tego `slice` leciał do końca pliku i asercja przechodziła na
   *  deklaracji z zupełnie innej reguły niżej — skasowanie tej właściwej
   *  nie wywaliłoby testu. */
  const ruleBody = (selector: string) => {
    const at = css.indexOf(selector);
    expect(at, `nie ma reguły ${selector}`).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  it("narożnik paska jest przezroczysty, a pasek poziomy tak samo cienki", () => {
    expect(ruleBody("::-webkit-scrollbar-corner")).toMatch(/background:\s*transparent/);
    expect(ruleBody("::-webkit-scrollbar {")).toMatch(/height:\s*8px/);
  });
});

// multibot: czip pokoju w prywatnym watku czlonka grupy pokazywal "X napisal(a)
// do Y, Z" — bez sensu, bo tura grupowa to JEDEN pokoj wspolny. Ma nazywac
// grupe i prowadzic do czatu grupy, w obu jezykach.
describe("czip pokoju grupowego", () => {
  const chip = chat.slice(chat.indexOf("function RoomChip"), chat.indexOf("function userEventChip"));

  it("dla pokoju grupy pisze o grupie zamiast \"napisal(a) do\"", () => {
    expect(chip).toContain("const groupId = room.groupId;");
    expect(chip).toContain('"Rozmowa w grupie"');
    expect(chip).toContain('"Group chat:"');
    expect(chip).toContain("{room.name}");
  });

  it("klikniecie otwiera grupe, nie pokoj", () => {
    const branch = chip.slice(chip.indexOf("if (groupId) {"), chip.indexOf("const owner ="));
    expect(branch).toContain("/api/groups/${encodeURIComponent(groupId)}");
    expect(branch).toContain('type: "toggleGroup"');
    expect(branch).not.toContain("toggleRoom");
  });

  it("group chat nie jest obramowana, ale zachowuje podświetlenie wiersza", () => {
    const branch = chip.slice(chip.indexOf("if (groupId) {"), chip.indexOf("const owner ="));
    const style = chip.slice(chip.indexOf("const groupPill ="), chip.indexOf("const groupId ="));
    expect(chip).toContain("const groupPill =");
    expect(branch).toContain("className={groupPill}");
    expect(style).not.toContain("border");
    expect(style).toContain("hover:bg-raised");
    expect(style).toContain("active:bg-raised-hover");
  });
});

// multibot: prywatny czat pokazuje rozmowę bot↔bot jako pigułki zdarzeń
// („Atlas napisał(a) do Gatekeepera", „Gatekeeper odpisał(a)"), a nie surowe
// koperty. Wariant „odpisał(a)" dodany razem z ukryciem kopert po stronie
// serwera — bez niego każda odpowiedź kolegi czytała się jak nowy list.
describe("pigułka pokoju: napisał(a) / odpisał(a)", () => {
  it("ma oba warianty w obu językach i wybiera je po room.event", () => {
    expect(chat).toContain('room.event === "replied"');
    for (const label of ["odpisał(a)", "replied", "napisał(a) do", "texted"]) {
      expect(chat, `brak wariantu ${label}`).toContain(label);
    }
  });
});

// multibot: karta rozmowy bot↔bot to DRZWI do pokoju, nie szuflada. Wersja
// z 07.09 (kierunkowa aktywność) zamieniła kliknięcie na rozwijanie w dół
// listy członków, przez co do pokoju nie dało się wejść w ogóle. Kierunkowy
// opis i awatary zostają, klikniecie ma znowu otwierać transkrypt. Sam link
// nie jest jednak pigułką, a status pokoju nie jest dopisywany do tekstu.
describe("karta bot↔bot otwiera pokój", () => {
  const card = chat.slice(chat.indexOf("function PeerActivity"), chat.indexOf("function RoomChip"));

  it("kliknięcie otwiera pokój, a nie rozwija karty", () => {
    expect(card).toContain("openRoom(room.id, dispatch)");
    expect(card).toContain('disabled={opening}');
    expect(card).toContain('aria-busy={opening}');
    expect(card).toContain("active:scale-[0.97]");
    expect(card).toContain("focus-visible:outline");
    expect(card).not.toContain("rounded-2xl border border-hairline/40 bg-panel");
    expect(card).not.toContain("statusLabel");
    for (const status of ["Completed", "Failed", "Working", "Ukończone", "Błąd", "W toku"]) {
      expect(card, `status nadal jest renderowany: ${status}`).not.toContain(status);
    }
    for (const drawer of ["setExpanded", "aria-expanded", "ChevronDown"]) {
      expect(card, `karta znowu rozwija się w dół: ${drawer}`).not.toContain(drawer);
    }
  });

  it("karta jest klikalna w obie strony, nie tylko dla nadawcy", () => {
    expect(card, "wariant „od kogoś\" znowu jest martwym <div>").not.toMatch(/sent \?\s*\(?\s*<button/);
    expect((card.match(/<button/g) ?? []).length, "karta ma być jednym przyciskiem").toBe(1);
  });

  it("zostaje kierunkowy opis i awatary", () => {
    for (const label of ["Napisano do", "Messaged", "Wiadomość od", "Message from"]) {
      expect(card, `brak kierunkowego opisu ${label}`).toContain(label);
    }
    expect(card).toContain("const avatars = sent ? [actor, ...peers] : [actor];");
  });

  it("obie karty wchodzą do pokoju tym samym helperem", () => {
    expect(chat).toContain('dispatch({ type: "toggleRoom", room: full })');
    expect((chat.match(/openRoom\(room\.id, dispatch\)/g) ?? []).length).toBe(2);
  });
});

describe("małe awatary rozmów botów", () => {
  it("oddziela stos avatarów w karcie aktywności", () => {
    const card = chat.slice(chat.indexOf("function PeerActivity"), chat.indexOf("function RoomChip"));
    expect(card).toContain("bg-app ring-2 ring-app");
    expect(card).toContain('shape="blob"');
  });

  it("oddziela avatary nagłówka i nadawcy w temporary chacie", () => {
    expect(roomPanel).toContain("bg-app ring-2 ring-app");
    expect(roomPanel).toContain('shape="blob"');
  });
});
