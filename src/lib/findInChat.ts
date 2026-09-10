// multibot: find-in-chat — trafienia liczysz po stronie klienta, bo cały
// transkrypt bota i tak siedzi w storze (port z upstreamu #437, tam był
// potrzebny endpoint /api/search, bo ich store nie trzyma pełnej listy).
//
// Podświetlanie idzie przez CSS Custom Highlight API (`CSS.highlights` +
// `::highlight()` w styles.css), a NIE przez wstawianie <mark> w drzewo.
// Powód jest twardy: dymki renderuje React (markdown, KaTeX, shiki), więc
// węzły tekstowe należą do niego. `splitText` pod <mark> rozbija węzeł, który
// React trzyma w fiberze — kolejna aktualizacja tekstu (strumień, edycja)
// wpisuje nową treść do JEDNEGO kawałka i wiadomość się rozjeżdża. Highlight
// API maluje po Range'ach: zero mutacji DOM-u, zero kolizji z rekoncyliacją.
// Wersje są w porządku: Electron 43 = Chromium ~140, Android WebView z Play
// Store ≥ Chromium 105 (sierpień 2022) — poniżej tego progu podświetlenie po
// prostu się nie rysuje, a licznik i przewijanie działają dalej.

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wszystkie (nienachodzące) pozycje `query` w `text`, bez rozróżniania
 *  wielkości liter. Regexp z flagą `i` zamiast `toLowerCase()`, bo zmiana
 *  wielkości potrafi zmienić DŁUGOŚĆ napisu (İ → i̇) i przesunąć offsety. */
export function findMatchPositions(text: string, query: string): number[] {
  const needle = query.trim();
  if (!needle) return [];
  const pattern = new RegExp(escapeRegExp(needle), "gi");
  const out: number[] = [];
  for (let hit = pattern.exec(text); hit; hit = pattern.exec(text)) {
    out.push(hit.index);
    pattern.lastIndex = hit.index + needle.length;
  }
  return out;
}

/** Następne/poprzednie trafienie z zawinięciem na obu końcach. */
export function wrapIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}

interface TextMap {
  nodes: Text[];
  starts: number[];
  text: string;
}

function textMap(root: Element): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    if (!value) continue;
    nodes.push(node as Text);
    starts.push(text.length);
    text += value;
  }
  return { nodes, starts, text };
}

/** Offset w sklejonym tekście → (węzeł, offset w węźle). */
function pointAt(map: TextMap, offset: number): [Text, number] {
  let low = 0;
  let high = map.starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (map.starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  const node = map.nodes[low];
  return [node, Math.min(offset - map.starts[low], node.length)];
}

/** Range'e wszystkich trafień w transkrypcie, w kolejności dokumentu.
 *  ponytail: tekst sklejam per dymek, nie per węzeł — dzięki temu „bold" w
 *  `**bo**ld` jest jednym trafieniem. Ceną jest teoretyczne trafienie na styku
 *  dwóch akapitów („worldNice"); jeśli kiedyś zaboli, sklejać per blok. */
export function collectMatchRanges(root: Element, query: string): Range[] {
  const needle = query.trim();
  if (!needle) return [];
  const ranges: Range[] = [];
  for (const block of root.querySelectorAll<HTMLElement>("[data-mb-body], .chat-md")) {
    const map = textMap(block);
    if (!map.nodes.length) continue;
    for (const start of findMatchPositions(map.text, needle)) {
      const [startNode, startOffset] = pointAt(map, start);
      const [endNode, endOffset] = pointAt(map, start + needle.length);
      const range = document.createRange();
      try {
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
      } catch {
        continue; // węzeł zniknął między zbieraniem a ustawieniem Range'a
      }
      ranges.push(range);
    }
  }
  return ranges;
}

const ALL = "mb-find";
const CURRENT = "mb-find-current";

const registry = (): Map<string, unknown> | undefined =>
  (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;

export function clearHighlights(): void {
  const highlights = registry();
  if (!highlights) return;
  highlights.delete(ALL);
  highlights.delete(CURRENT);
}

/** Bieżące trafienie idzie do OSOBNEGO rejestru i wypada z „reszty" — bez
 *  nakładania się nie trzeba bawić się priorytetami Highlightów. */
export function paintHighlights(ranges: Range[], current: number): void {
  const highlights = registry();
  const Ctor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!highlights || !Ctor) return;
  clearHighlights();
  if (!ranges.length) return;
  const others = ranges.filter((_, index) => index !== current);
  if (others.length) highlights.set(ALL, new Ctor(...others));
  const active = ranges[current];
  if (active) highlights.set(CURRENT, new Ctor(active));
}
