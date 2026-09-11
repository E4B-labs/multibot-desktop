// multibot (2.4): wzmianki `@imię bota` renderują się jako chip z awatarem,
// nie surowy tekst. Wtyczka remark rozbija węzły tekstowe markdowna na
// segmenty; imiona przychodzą ze store'a, więc komponent nie potrzebuje
// nowych propsów, a bloki kodu zostają nietknięte (remark ich nie rusza).
//
// Osobny plik, bo to czysta logika bez Reacta — dzięki temu ma test, który
// odpala się w środowisku node razem z resztą pakietu.

/** Kształt, którego potrzebuje rozpoznawanie wzmianek — dokładnie ten sam, co
 *  `mentionedBots` na serwerze (`server/store.ts`). */
export type MentionBot = { name: string; hidden?: boolean };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Kandydaci wzmianki: bez ukrytych i bez nazw z samych spacji, dłuższe
 *  pierwsze. Reguła co do znaku z `mentionedBots` w `server/store.ts` —
 *  `.filter((p) => !p.hidden && p.name.trim())` plus sortowanie po długości. */
function mentionNames(bots: MentionBot[]): string[] {
  return bots
    .filter((bot) => !bot.hidden && bot.name.trim())
    .map((bot) => bot.name)
    .sort((a, b) => b.length - a.length);
}

/** Jednoelementowy cache: `mentionRegex` woła się przy każdym znaku w
 *  composerze i przy każdym dymku użytkownika w transkrypcie, a roster zmienia
 *  się raz na kilka minut. Klucz to sklejone nazwy — po nich i tylko po nich
 *  wzorzec się różni. */
let cached: { key: string; re: RegExp } | null = null;

/**
 * JEDNA definicja tego, czym jest wzmianka po stronie klienta — używa jej
 * markdown wysłanej wiadomości, dymek użytkownika i podświetlenie w composerze
 * (K2). Musi zgadzać się z `mentionedBots` na serwerze, bo to serwer decyduje,
 * kto NAPRAWDĘ zostanie ztagowany; pigułka nad nazwą, której serwer nie
 * rozpozna, to kłamstwo w interfejsie. Stąd dokładnie te dwie reguły serwera:
 *
 *   1. „@" stoi na początku tekstu albo po BIAŁYM ZNAKU (serwer:
 *      `if (at > 0 && !/\s/.test(text[at - 1])) continue`). Adres pocztowy
 *      (`ktos@example.com`) i „(@Nazwa" zostają surowe — grupa 1 wraca do tekstu.
 *   2. Po nazwie NIE MA granicy (serwer: `rest.startsWith(name)`), więc
 *      „@New Bots" tagguje „New Bot". Lookahead `(?![\w-])` był tu wcześniej
 *      i rozjeżdżał się z serwerem: chip nie pojawiał się tam, gdzie tag
 *      realnie działał.
 *
 * Bez lookbehind (`(?<!…)`): starsze WebView Androida (przed Chrome 62)
 * rzucają na nim SyntaxError przy wczytaniu paczki, co kończy się czarnym ekranem.
 */
export function mentionRegex(bots: MentionBot[]): RegExp {
  const names = mentionNames(bots);
  const key = names.join(" ");
  if (cached?.key !== key) cached = { key, re: new RegExp(`(^|\\s)@(${names.map(escapeRe).join("|")})`, "gi") };
  return cached.re;
}

/** Segment tekstu: `name` ustawione = to wzmianka, `text` to zawsze surowe
 *  znaki z wejścia (`@Imię`), nigdy nazwa wyświetlana. */
export interface MentionSegment {
  text: string;
  name?: string;
}

/**
 * Rozbija surowy tekst na segmenty zwykłe i wzmianki. Suma `text` wszystkich
 * segmentów to dokładnie wejście — na tym stoi podświetlanie w composerze,
 * gdzie warstwa pod textareą musi mieć co do znaku tę samą treść.
 */
export function splitMentions(value: string, bots: MentionBot[]): MentionSegment[] {
  // Pusta lista kandydatów dałaby pustą alternatywę w regexie, czyli wzmiankę
  // z samego „@" — w composerze widać to natychmiast: gołe „@" robiło się
  // pigułką, jeszcze przed napisaniem jakiejkolwiek nazwy.
  if (!value || !mentionNames(bots).length) return [{ text: value }];
  const re = mentionRegex(bots);
  const out: MentionSegment[] = [];
  let last = 0;
  // Wzorzec jest wspólny (cache wyżej), więc zaczynamy od znanego stanu —
  // `exec` zeruje `lastIndex` sam tylko po zwróceniu `null`.
  re.lastIndex = 0;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const at = m.index + m[1].length;
    const label = `@${m[2]}`;
    if (at > last) out.push({ text: value.slice(last, at) });
    out.push({ text: label, name: m[2] });
    last = at + label.length;
  }
  if (!out.length) return [{ text: value }];
  if (last < value.length) out.push({ text: value.slice(last) });
  return out;
}

/**
 * unified woła atacher SAM — `use(fn, opcje)` albo krotka `[fn, opcje]` na
 * liście wtyczek. Wywołanie `remarkMentions({ bots })` bezpośrednio W LIŚCIE
 * oddawało unifiedowi gotowy transformer, który unified brał za atacher i
 * odpalał BEZ drzewa: `walk(undefined)` rzucało „Cannot read properties of
 * undefined (reading 'children')", `#root` zostawał pusty i aplikacja
 * pokazywała czarny ekran na telefonie i na desktopie. Stąd `mentionPlugins`
 * niżej oddaje krotkę i stąd test, który tę pomyłkę odtwarza.
 */
export function remarkMentions({ bots }: { bots: MentionBot[] }) {
  return (tree: any) => {
    const split = (node: any): any[] => {
      const parts = splitMentions(node.value, bots);
      if (!parts.some((part) => part.name)) return [node];
      return parts.map((part) =>
        part.name
          ? {
              type: "mention",
              data: { hName: "span", hProperties: { dataMention: part.name } },
              children: [{ type: "text", value: part.text }],
            }
          : { type: "text", value: part.text },
      );
    };
    const walk = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child.type === "text") node.children.splice(i, 1, ...split(child));
        else walk(child);
      }
    };
    walk(tree);
  };
}

/**
 * Lista wtyczek remark dla wiadomości czatu. `gfm` zawsze; wzmianki dopiero
 * gdy są jakieś imiona — pusta alternatywa w regexie łapałaby każde „@".
 */
export function mentionPlugins(gfm: unknown, bots: MentionBot[]): unknown[] {
  // Kandydaci, nie surowa długość listy: roster z samych ukrytych botów (albo
  // z nazwami ze spacji) nie ma czego dopasować.
  return mentionNames(bots).length ? [gfm, [remarkMentions, { bots }]] : [gfm];
}
