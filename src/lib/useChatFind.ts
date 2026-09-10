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
      timer = setTimeout(bump, 120);
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
    } else {
      // to samo zapytanie, przeliczone po zmianie DOM — nie wyrywaj z miejsca
      setIndex((current) => (found.length ? Math.min(current, found.length - 1) : 0));
    }
  }, [open, query, revision, scrollRef]);

  // malowanie + przewijanie bieżącego trafienia na środek listy
  useEffect(() => {
    paintHighlights(ranges.current, index);
    const range = ranges.current[index];
    const root = scrollRef.current;
    if (!range || !root) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return; // Range osierocony przez re-render
    const box = root.getBoundingClientRect();
    root.scrollTop += rect.top - box.top - box.height / 2 + rect.height / 2;
  }, [index, total, revision, scrollRef]);

  useEffect(() => clearHighlights, []);

  const move = useCallback((delta: number) => {
    setIndex((current) => wrapIndex(current, delta, ranges.current.length));
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
