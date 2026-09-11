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

/** Linie wrappera-wiersza nad dymkiem: to na nim siedzi teraz sufit
 *  szerokości (`max-w-[…]`) — rząd przycisków (TTS/kopiuj) stoi na prawo
 *  od dymka, więc dymek i przyciski dzielą jeden wiersz o wspólnym suficie. */
function wrapperLines(): string[] {
  // Wrapper znajdujemy przez kotwicę do dymka: to najbliższa NAD dymkiem
  // linia z `items-end`. Sam grep po `max-w-[` łapał też kolumnę
  // załączników (`max-w-[70%] … gap-2`), która dymkiem nie jest.
  const lines = chat.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i].includes("rounded-2xl") && lines[i].includes("py-[5px]"))) continue;
    for (let j = i - 1; j >= 0 && j >= i - 30; j--) {
      if (lines[j].includes("items-end")) {
        out.push(lines[j]);
        break;
      }
    }
  }
  return out;
}

/** Szerokości z linii wrapperów wierszy dymków. */
function bubbleWidths(): string[] {
  const out: string[] = [];
  for (const line of wrapperLines()) {
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

  // multibot: rząd kopiuj/TTS stoi na PRAWO od dymka (wyrównany do dołu),
  // nie pod nim — pod dymkiem nie ma dodatkowej wysokości, więc dymki bota
  // niemal się stykają. Przyciski `shrink-0`, żeby nie kurczył ich sufit.
  it("przyciski stoją obok dymka, nie pod nim", () => {
    for (const line of wrapperLines()) {
      expect(line, `wrapper wrócił do kolumny: ${line.trim()}`).not.toContain("flex-col");
      expect(line, `wrapper bez wyrównania do dołu: ${line.trim()}`).toContain("items-end");
    }
    expect(chat).toContain('"flex shrink-0 items-center gap-1.5 text-[10px] leading-none"');
  });

  it("dymek jest szeroki, nie zwężony do jednej trzeciej", () => {
    expect(Number.parseInt(bubbleWidths()[0], 10)).toBeGreaterThanOrEqual(80);
  });

  // multibot: `max-w-` to sufit, nie szerokość — wrapper wiersza jest
  // elementem flexa, więc kurczy się do treści i jednoliniowa odpowiedź bota
  // („Sesja wygasła, loguję się ponownie.") zajmuje tyle, ile potrzebuje.
  // `w-full` w tej samej klasie zamienia sufit w szerokość na sztywno i każdy
  // dymek staje się pasem na całą kolumnę. Mobilna kopia webui zrobiła
  // dokładnie to (Kacper 08.09, zrzut z telefonu), stąd strażnik po tej
  // stronie. Sufit pilnujemy na wrapperze (tam się przeniósł), a `w-full`
  // nie może wrócić ani na wrapper, ani na sam dymek.
  it("dymek ma sufit szerokości, a nie sztywną pełną szerokość", () => {
    const wrappers = wrapperLines();
    expect(wrappers.length, "nie znalazłem wrapperów dymków").toBeGreaterThanOrEqual(2);
    // `\b` nie wystarcza: w `max-w-full` przed „w" też stoi granica słowa.
    for (const line of wrappers) {
      expect(line, `wrapper bez sufitu szerokości: ${line.trim()}`).toContain("max-w-[");
      expect(line, `wrapper przypięty do pełnej szerokości: ${line.trim()}`).not.toMatch(/(?<![-\w])w-full\b/);
    }
    const bubbles = bubbleLines();
    expect(bubbles.length, "nie znalazłem linii dymków").toBeGreaterThanOrEqual(2);
    for (const line of bubbles) {
      expect(line, `dymek przypięty do pełnej szerokości: ${line.trim()}`).not.toMatch(/(?<![-\w])w-full\b/);
    }
  });
});

// multibot: awatar w pasku nad rozmową ma stać nieruchomo, gdy bot nie
// pracuje. Wcześniej BotAvatar size 40 dostawał gołe `animated` plus
// jednorazowy beat z `state.mascotMotion`, więc bezczynny bot mrugał
// i oddychał, choć ten sam bot w pasku bocznym już stał.
describe("awatar w nagłówku czatu", () => {
  it("nie jest animowany na sztywno", () => {
    expect(chat, "nagłówek wrócił do `animated` bez warunku").not.toMatch(/^\s*animated\s*$/m);
    expect(chat, "nagłówek znowu odtwarza jednorazowy state.mascotMotion").not.toContain(
      "state.mascotMotion",
    );
  });

  it("liczy propsy helperem, który NIGDY nie animuje (drugi blob obok paska nad composerem to drugi sygnał tej samej tury)", () => {
    expect(chat).toContain("staticAvatarProps(bot)");
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
    // sufit siedzi na wrapperze kolumny, więc to on musi mieć `min-w-0`,
    // żeby jako element flexa umiał zejść poniżej min-content…
    const wrappers = wrapperLines();
    expect(wrappers.length).toBeGreaterThanOrEqual(2);
    for (const line of wrappers) {
      expect(line, `wrapper bez min-w-0: ${line.trim()}`).toContain("min-w-0");
    }
    // …a sam dymek dalej łamie długie tokeny i też się kurczy.
    const bubbles = bubbleLines();
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
    expect(card).not.toContain("const avatars = sent ? [actor, ...peers] : [actor];");
    expect(card).toContain("id !== currentBotId");
    expect(card).toContain("bot.id === currentBotId");
    expect(card).toContain('"--bot": BOT_COLORS[bot.color]');
    expect(card).toContain('dispatch({ type: "select", id: bot.id })');
    expect(card).toContain("stopPropagation");
  });

  it("obie karty wchodzą do pokoju tym samym helperem", () => {
    expect(chat).toContain('dispatch({ type: "toggleRoom", room: full })');
    expect((chat.match(/openRoom\(room\.id, dispatch\)/g) ?? []).length).toBe(2);
  });
});

describe("małe awatary rozmów botów", () => {
  it("umieszcza pojedynczy mały avatar w chipie obok nazwy", () => {
    const card = chat.slice(chat.indexOf("function PeerActivity"), chat.indexOf("function RoomChip"));
    expect(card).toContain('role="link"');
    expect(card).toContain('size={20}');
    expect(card).toContain('shape="blob"');
    expect(card).toContain("{...staticAvatarProps(bot)}");
    expect(card).toContain("inline-flex items-center gap-1 rounded-full");
    expect(card).not.toContain("-space-x-1");
    // obwódka hovera nie może być obcinana przez `overflow-hidden` wiersza
    for (const token of ["overflow-hidden", "p-1 -m-1", "items-center"]) expect(card).toContain(token);
    expect(card).not.toContain("state={stateForBot(bot)}");
  });

  it("chip ma wypełnienie i tekst w kolorze bota już w spoczynku", () => {
    const card = chat.slice(chat.indexOf("function PeerActivity"), chat.indexOf("function RoomChip"));
    // spoczynek: obwódka + wypełnienie + tekst, nie tylko wariant `hover:`
    expect(card).toContain("[box-shadow:0_0_0_1px_var(--bot-ink)]");
    expect(card).toContain("text-[var(--bot-ink)]");
    expect(card).toContain("bg-[color-mix(in_oklab,var(--bot)_18%,var(--color-app))]");
    expect(card).toContain("hover:bg-[color-mix(in_oklab,var(--bot)_32%,var(--color-app))]");
    expect(card).not.toContain("hover:[box-shadow:0_0_0_1px_var(--bot)]");
    // tekst zostaje w kolorze bota także pod kursorem (przycisk karty ma
    // własne `hover:text-ink` — patrzymy tylko w blok chipa)
    const chipBlock = card.slice(card.indexOf("const chip ="), card.indexOf("const visiblePeers ="));
    expect(chipBlock).not.toContain("text-ink");
    // atrament miesza się ze skórką, inaczej yellow/white/black toplo w tle
    expect(card).toContain('"--bot-ink": "color-mix(in oklab, var(--bot) 50%, var(--color-ink))"');
  });

  it("oddziela avatary nagłówka i nadawcy w temporary chacie", () => {
    expect(roomPanel).toContain("bg-app ring-2 ring-app");
    expect(roomPanel).toContain('shape="blob"');
    expect(roomPanel).toContain("{...staticAvatarProps(bot)}");
    expect(roomPanel).not.toContain("state={stateForBot(bot)}");
  });
});

// multibot: seria dymków (iMessage/Grok). Kilka wiadomości pod rząd od tej
// samej strony ma się czytać jak jeden blok — rogi styku ostrzejsze, rogi
// zewnętrzne pełne, odstęp w środku serii mniejszy niż między nadawcami.
// Reguły siedzą w styles.css (`[data-mb-side]`, `:has(+ …)`), bo o serii
// decyduje sąsiedztwo w DOM, a nie indeks wiadomości. Bez DOM w vitest
// sprawdzamy sam kontrakt: który róg tnie która reguła i jaki wychodzi
// odstęp — mylny (odbity) róg to tu najłatwiejszy błąd.
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Wszystkie reguły serii ze styles.css: selektor → treść deklaracji. */
function seriesRules(): Array<{ selector: string; body: string }> {
  return [...styles.matchAll(/(\[data-mb-side[^{]*)\{([^}]*)\}/g)].map((match) => ({
    selector: match[1].replace(/\s+/g, " ").trim(),
    body: match[2],
  }));
}

function cornerRule(side: "bot" | "user", edge: "top" | "bottom"): string {
  const row = `[data-mb-side="${side}"]`;
  // róg GÓRNY tnie dymek, NAD którym stoi dymek tej samej strony (`+`);
  // róg DOLNY ten, POD którym taki dymek stoi (`:has(+ …)`)
  const selector = edge === "top"
    ? `${row} + ${row} [data-mb-bubble]`
    : `${row}:has(+ ${row}) [data-mb-bubble]`;
  return seriesRules().find((rule) => rule.selector === selector)?.body ?? "";
}

describe("seria dymków czatu", () => {
  it("ostrzy tylko róg styku i tylko po wewnętrznej stronie dymka", () => {
    // bot stoi po lewej → jego rogi wewnętrzne są LEWE; użytkownik odwrotnie
    expect(cornerRule("bot", "top"), "brak reguły górnego rogu bota").toMatch(/border-top-left-radius:\s*6px/);
    expect(cornerRule("bot", "bottom"), "brak reguły dolnego rogu bota").toMatch(/border-bottom-left-radius:\s*6px/);
    expect(cornerRule("user", "top"), "brak reguły górnego rogu użytkownika").toMatch(/border-top-right-radius:\s*6px/);
    expect(cornerRule("user", "bottom"), "brak reguły dolnego rogu użytkownika").toMatch(/border-bottom-right-radius:\s*6px/);
    for (const edge of ["top", "bottom"] as const) {
      expect(cornerRule("bot", edge), "dymek bota ścina róg zewnętrzny").not.toContain("right-radius");
      expect(cornerRule("user", edge), "dymek użytkownika ścina róg zewnętrzny").not.toContain("left-radius");
    }
  });

  it("zostawia w serii mniejszy odstęp niż między nadawcami", () => {
    // lista wiadomości: `gap-1` = 4 px między nadawcami
    expect(chat).toContain('className="flex w-full min-w-0 flex-col gap-1 pb-16"');
    const gap = 4;
    // po `+`, żeby przyszła reguła `[data-mb-side]` z własnym marginesem
    // nie podszyła się pod tę jedną, która zwiera odstęp w serii
    const rule = seriesRules().find((entry) => entry.selector.includes("+") && entry.body.includes("margin-top"));
    const shift = Number.parseFloat(/margin-top:\s*(-?[\d.]+)px/.exec(rule?.body ?? "")?.[1] ?? "NaN");
    expect(shift, "brak reguły zwierającej odstęp w serii").toBeLessThan(0);
    expect(gap + shift, "dymki serii sklejają się albo nachodzą").toBeGreaterThan(0);
    expect(gap + shift, "odstęp w serii nie jest mniejszy od zwykłego").toBeLessThan(gap);
    // ta sama reguła musi obejmować obie strony, nie tylko jedną
    for (const side of ["bot", "user"]) {
      expect(rule?.selector, `seria ${side} bez zwarcia odstępu`).toContain(`[data-mb-side="${side}"] + [data-mb-side="${side}"]`);
    }
  });

  it("oznacza każdy dymek — gotowy i strumieniowany", () => {
    const sides = [...chat.matchAll(/data-mb-side=(?:"([a-z]+)"|\{[^}]*\})/g)];
    expect(sides.length, "nie każdy wiersz dymka niesie data-mb-side").toBe(bubbleLines().length);
    expect((chat.match(/data-mb-bubble/g) ?? []).length, "nie każdy dymek niesie data-mb-bubble").toBe(bubbleLines().length);
    // `[data-mb-side] [data-mb-bubble]` to selektor POTOMKA: gdyby oba
    // znaczniki wylądowały na jednym elemencie, reguły przestałyby trafiać
    expect(chat, "oba znaczniki na jednym elemencie").not.toMatch(/data-mb-side=[^\n]*data-mb-bubble|data-mb-bubble=[^\n]*data-mb-side/);
  });
});

// Trzeci poziom widoczności (Status). Do 0.5.45 ikona komputera świeciła
// WYŁĄCZNIE wtedy, gdy panel był otwarty — czyli nigdy dlatego, że bot klika.
// Zachowanie stanu pilnuje reduktor (src/state/store.test.ts); tutaj zostaje
// jedna lekka asekuracja, że nagłówek w ogóle czyta tę flagę.
describe("ikona komputera w nagłówku", () => {
  it("akcent bierze się z pracy bota, nie tylko z otwartego panelu", () => {
    expect(chat).toMatch(/computerActing\s*\|\|\s*state\.computerOpen\s*\?\s*"text-accent"/);
  });
});

// K5: na telefonie „Pobierz" idzie przez most natywny, ale przeglądarka
// i Electron muszą ZOSTAĆ przy `<a download>` — dlatego link nigdy nie jest
// zamieniany na przycisk, a `preventDefault()` wisi pod warunkiem z mostu
// (`openFileViaShell` zwraca tam false; test wykonawczy w lib/nativeBridge.test.ts).
describe("pobranie pliku przez powłokę telefonu", () => {
  const card = readFileSync(new URL("./AttachmentCard.tsx", import.meta.url), "utf8");
  const preview = readFileSync(new URL("./AttachmentPreview.tsx", import.meta.url), "utf8");

  it("zostawia link z download i tylko warunkowo blokuje jego domyślne działanie", () => {
    for (const source of [card, preview]) {
      expect(source).toContain("download={name}");
      expect(source).toContain("if (path && openFileViaShell(path, name, mime ?? \"\")) e.preventDefault();");
    }
  });

  it("kafelek HTML wraca do window.open, gdy mostu nie ma", () => {
    expect(chat).toContain("if (openFileViaShell(path, file.name, file.mime)) return;");
    expect(chat).toContain("if (url) window.open(url, \"_blank\", \"noopener,noreferrer\");");
  });
});

// multibot K2: wzmianka nie może zniknąć w chwili wysłania. Composer koloruje
// `@Imię` w trakcie pisania; dymek użytkownika leci czystym tekstem, więc bez
// MentionText wracał tam surowy zapis i chip „gasł" po Enterze.
describe("wzmianka w wysłanej wiadomości użytkownika", () => {
  const peerBadge = readFileSync(new URL("./PeerBadge.tsx", import.meta.url), "utf8");

  it("dymek użytkownika renderuje treść przez MentionText, nie gołe {body}", () => {
    expect(chat).toContain("<MentionText text={body} />");
    expect(chat).toContain('import { MentionText, PeerBadge } from "./PeerBadge";');
  });

  it("MentionText używa tego samego tokenizera i tej samej pigułki co reszta", () => {
    expect(peerBadge).toContain('import { splitMentions } from "@/lib/mentions";');
    expect(peerBadge).toContain("<BotChip key={index} bot={bot} />");
    // bez wzmianki zwraca sam tekst — żadnego nowego opakowania w dymku
    expect(peerBadge).toContain("if (!parts.some((part) => part.name)) return <>{text}</>;");
  });

  // K2 (recenzja PR #185, p. 9): pigułka w wysłanej wiadomości ma kolor bota,
  // tak jak ta w composerze. Przepis `--bot`/`--bot-ink` stoi w JEDNYM miejscu.
  it("pigułka wysłanej wiadomości bierze kolor bota z jednego przepisu", () => {
    expect(peerBadge).toContain("export function botChipStyle(color?: BotColor): CSSProperties");
    expect(peerBadge).toContain('"--bot-ink": "color-mix(in oklab, var(--bot) 50%, var(--color-ink))"');
    expect(peerBadge).toContain("text-[var(--bot-ink)]");
    expect(peerBadge).toContain("bg-[color-mix(in_oklab,var(--bot)_18%,var(--color-app))]");
    expect(peerBadge, "pigułka wróciła do szarego bg-raised").not.toContain("bg-raised px-2 py-0.5");
    // każda droga do pigułki ustawia zmienne — bez nich `color-mix` jest
    // nieprawidłowy i tekst traci kolor
    expect(peerBadge).toContain("<span style={botChipStyle(bot.color)} className={cn(BOT_CHIP_CLASS, className)}>");
    expect(peerBadge).toContain('<span style={botChipStyle()} className={cn(BOT_CHIP_CLASS, "mr-1.5")}>');
  });
});
