// multibot: stan paska „Szukaj w rozmowie". Siedzi w osobnym pliku, bo
// ChatView.tsx jest już gruby i dostaje równolegle zmiany od innych — hook
// trzyma cały cykl (zbierz trafienia → pomaluj → przewiń) w jednym miejscu.
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";
import { clearHighlights, collectMatchRanges, paintHighlights, wrapIndex } from "./findInChat";

export interface ChatFind {
  /** to, co widać w polu — bez opóźnienia */
  raw: string;
  setRaw: (value: string) => void;
  total: number;
  /** 0-based; do licznika „3/17" dodaj 1 */
  index: number;
  move: (delta: number) => void;
  reset: () => void;
}

export function useChatFind(scrollRef: RefObject<HTMLElement | null>, open: boolean): ChatFind {
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(0);
  const [revision, bump] = useReducer((value: number) => value + 1, 0);
  // Przewijanie chodzi na WŁASNYM liczniku, nie na `index`/`revision`. Inaczej
  // każde przeliczenie po zmianie DOM (a przy strumieniowanej odpowiedzi leci
  // co 400 ms) ściągałoby widok z powrotem na trafienie i nie dało się czytać
  // niczego innego przy otwartym pasku.
  const [navTick, nav] = useReducer((value: number) => value + 1, 0);
  const ranges = useRef<Range[]>([]);
  const lastQuery = useRef<string | null>(null);

  // debounce 150 ms — pisanie nie powinno przechodzić drzewa co klawisz
  useEffect(() => {
    const timer = setTimeout(() => setQuery(raw), 150);
    return () => clearTimeout(timer);
  }, [raw]);

  // Range'y wskazują na KONKRETNE węzły tekstowe, a transkrypt się rusza:
  // dochodzi wiadomość, shiki podmienia blok kodu na pokolorowany, KaTeX
  // dorysowuje wzór. Po takiej podmianie Range wisi w powietrzu i podświetlenie
  // znika bez śladu — stąd obserwator, który każe policzyć trafienia od nowa.
  useEffect(() => {
    const root = scrollRef.current;
    if (!open || !root) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      // ponytail: 400 ms i pełne przejście drzewa. Przy strumieniu to i tak
      // 2,5 przebiegu na sekundę; gdyby zabolało na wielotysięcznym
      // transkrypcie, przeliczać tylko bloki z MutationRecord.target.
      timer = setTimeout(bump, 400);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [open, scrollRef]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!open || !root || !query.trim()) {
      ranges.current = [];
      lastQuery.current = null;
      setTotal(0);
      setIndex(0);
      clearHighlights();
      return;
    }
    const found = collectMatchRanges(root, query);
    ranges.current = found;
    setTotal(found.length);
    if (lastQuery.current !== query) {
      // nowe zapytanie → start na NAJNOWSZYM trafieniu, tak czyta się rozmowę
      lastQuery.current = query;
      setIndex(found.length ? found.length - 1 : 0);
      nav();
    } else {
      // to samo zapytanie, przeliczone po zmianie DOM — nie wyrywaj z miejsca
      setIndex((current) => (found.length ? Math.min(current, found.length - 1) : 0));
    }
  }, [open, query, revision, scrollRef]);

  // Malowanie. `query` MUSI być w zależnościach: doprecyzowanie zapytania
  // („erro" → „error") potrafi dać tyle samo trafień, więc ani `total`, ani
  // `index` się nie ruszą i stare Range'y zostałyby na ekranie.
  useEffect(() => {
    paintHighlights(ranges.current, index);
  }, [index, total, revision, query]);

  // Przewijanie — tylko po skoku na inne trafienie albo po nowym zapytaniu.
  useEffect(() => {
    const range = ranges.current[index];
    const root = scrollRef.current;
    if (!range || !root) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return; // Range osierocony przez re-render
    const box = root.getBoundingClientRect();
    root.scrollTop += rect.top - box.top - box.height / 2 + rect.height / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTick, scrollRef]);

  useEffect(() => clearHighlights, []);

  const move = useCallback((delta: number) => {
    setIndex((current) => wrapIndex(current, delta, ranges.current.length));
    nav();
  }, []);

  const reset = useCallback(() => {
    setRaw("");
    setQuery("");
    ranges.current = [];
    lastQuery.current = null;
    setTotal(0);
    setIndex(0);
    clearHighlights();
  }, []);

  return { raw, setRaw, total, index, move, reset };
}
