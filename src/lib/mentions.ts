// multibot (2.4): wzmianki `@imię bota` renderują się jako chip z awatarem,
// nie surowy tekst. Wtyczka remark rozbija węzły tekstowe markdowna na
// segmenty; imiona przychodzą ze store'a, więc komponent nie potrzebuje
// nowych propsów, a bloki kodu zostają nietknięte (remark ich nie rusza).
//
// Osobny plik, bo to czysta logika bez Reacta — dzięki temu ma test, który
// odpala się w środowisku node razem z resztą pakietu.

/** Wystarczy imię; store podaje pełnego bota, struktura pasuje. */
export type MentionBot = { name: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * JEDNA definicja tego, czym jest wzmianka — używa jej i markdown wysłanej
 * wiadomości, i podświetlenie w composerze (K2). Dłuższe imiona idą pierwsze,
 * więc „@New Bot" wygrywa z „@New".
 *
 * Bez lookbehind (`(?<!…)`): starsze WebView Androida (przed Chrome 62)
 * rzucają na nim SyntaxError przy wczytaniu paczki, co kończy się czarnym
 * ekranem. Grupa 1 to znak przed „@" — wraca do tekstu, więc adresy pocztowe
 * (`ktos@example.com`) zostają w całości.
 */
export function mentionRegex(bots: MentionBot[]): RegExp {
  // Pusta nazwa dałaby pustą alternatywę, czyli wzmiankę z samego „@" —
  // w composerze widać to od razu: gołe „@" robiło się pigułką w trakcie
  // pisania, jeszcze przed jakąkolwiek nazwą.
  const names = bots
    .map((b) => b.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  return new RegExp(`(^|[^\\w.@-])@(${names.join("|")})(?![\\w-])`, "gi");
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
  if (!value || !bots.some((bot) => bot.name)) return [{ text: value }];
  const re = mentionRegex(bots);
  const out: MentionSegment[] = [];
  let last = 0;
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
  return bots.length ? [gfm, [remarkMentions, { bots }]] : [gfm];
}
