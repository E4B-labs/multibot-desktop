import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/** multibot: szerokość każdego panelu bocznego ciągnie się myszą, tak jak szyna
 * botów (Sidebar). Jedno miejsce na całą mechanikę: clamp, zapis w
 * localStorage, przechwycony wskaźnik (działa też palcem), klawiatura
 * i dwuklik = powrót do domyślnej.
 *
 * Wyjątek: pasek „Znajdź w czacie" (ChatFindBar) NIE jest panelem bocznym —
 * leży nad transkryptem i szerokość bierze z kolumny czatu. */

/** Poniżej ~280 px nagłówki paneli łamią się po dwóch słowach. */
export const PANEL_MIN_WIDTH = 280;
/** Panel nigdy nie zjada czatu: najwyżej 60% okna… */
export const PANEL_MAX_VW = 0.6;
/** …a w wąskim oknie 60% to za dużo: Kacper 29.08 zbił panel do 340 px właśnie
 * dlatego, że reszta czatu łamała tekst po trzech słowach. Kolumna czatu ma
 * więc własną podłogę, twardszą niż procent. Przy minimalnym oknie Electrona
 * (900 px) daje to 420 px na panel zamiast 540. */
export const CHAT_MIN_WIDTH = 480;

export type ResizeSide = "left" | "right";

export function clampPanelWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min;
  return Math.min(Math.max(Math.round(width), min), Math.max(min, max));
}

/** Uchwyt po lewej stronie panelu rośnie przy ciągnięciu w lewo — stąd znak. */
export function panelWidthFromDrag(
  startWidth: number,
  deltaX: number,
  side: ResizeSide,
  clamp: (width: number) => number,
): number {
  return clamp(startWidth + (side === "left" ? -deltaX : deltaX));
}

/** 60% okna albo tyle, ile zostaje po podłodze czatu — co mniejsze; nigdy
 * poniżej `min` (okno węższe niż panel przy `min`). */
export function viewportMaxWidth(min: number, innerWidth: number): number {
  if (!Number.isFinite(innerWidth) || innerWidth <= 0) return min;
  const room = Math.min(Math.round(innerWidth * PANEL_MAX_VW), innerWidth - CHAT_MIN_WIDTH);
  return Math.max(min, room);
}

export function readStoredWidth(key: string, fallback: number, clamp: (width: number) => number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null || raw.trim() === "") return fallback;
    const stored = Number(raw);
    return Number.isFinite(stored) ? clamp(stored) : fallback;
  } catch {
    // Tryb prywatny / storage wyłączony: panel działa, tylko nie pamięta.
    return fallback;
  }
}

export type ResizableWidth = {
  width: number;
  resizing: boolean;
  side: ResizeSide;
  label: string;
  min: number;
  max: number;
  setWidth: (width: number) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
};

export type ResizableWidthOptions = {
  /** Szerokość startowa i ta, do której wraca dwuklik. */
  defaultWidth: number;
  min?: number;
  /** Stała górna granica; bez niej 60% okna, przeliczane przy zmianie rozmiaru. */
  max?: number;
  side?: ResizeSide;
  label: string;
  /** Własne domknięcie (szyna botów zwija się do ikon poniżej progu). */
  clamp?: (width: number) => number;
};

const KEYBOARD_STEP = 16;

export function useResizableWidth(key: string, options: ResizableWidthOptions): ResizableWidth {
  const { defaultWidth, min = PANEL_MIN_WIDTH, max: fixedMax, side = "left", label } = options;
  const [max, setMax] = useState(() =>
    fixedMax ?? viewportMaxWidth(min, typeof window === "undefined" ? 0 : window.innerWidth),
  );
  const customClamp = options.clamp;
  const clamp = useCallback(
    (width: number) => (customClamp ? customClamp(width) : clampPanelWidth(width, min, max)),
    [customClamp, min, max],
  );
  // Ref, żeby nasłuchy wskaźnika i okna nie musiały się przepinać przy każdym pikselu.
  const clampRef = useRef(clamp);
  clampRef.current = clamp;

  // `desired` to szerokość WYBRANA przez użytkownika i tylko ona idzie do
  // localStorage. Rysowana szerokość jest z niej wyliczana — dzięki temu
  // zwężenie okna chowa nadmiar zamiast go skasować: po powrocie do szerokiego
  // okna panel wraca tam, gdzie użytkownik go postawił.
  //
  // Odczyt domyka WYŁĄCZNIE od dołu: sufit z okna zmienia się co chwilę
  // (a w kopii mobilnej na telefonie schodzi do minimum), więc domykanie nim
  // przy wczytaniu obcinałoby zapamiętaną wartość raz na zawsze.
  const [desired, setDesired] = useState(() =>
    readStoredWidth(key, defaultWidth, customClamp ?? ((w: number) => clampPanelWidth(w, min, Number.MAX_SAFE_INTEGER))),
  );
  const width = clamp(desired);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  /** Czy OSTATNI gest ruszył uchwyt — patrz `onDoubleClick`. */
  const movedRef = useRef(false);

  const setWidth = useCallback((next: number) => setDesired(clampRef.current(next)), []);

  // Okno zwężone po zapisaniu szerokości: panel musi zejść razem z nim,
  // inaczej po zmniejszeniu okna nie widać już czatu.
  useEffect(() => {
    if (fixedMax != null) return;
    const update = () => {
      // Zminimalizowane okno potrafi zgłosić 0 — wtedy nie ma czego liczyć.
      if (window.innerWidth > 0) setMax(viewportMaxWidth(min, window.innerWidth));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [fixedMax, min]);

  useEffect(() => {
    // W trakcie ciągnięcia zapis leciałby przy każdej klatce wskaźnika.
    if (resizing) return;
    try {
      window.localStorage.setItem(key, String(desired));
    } catch {
      // jw. — brak zapisu nie psuje bieżącej sesji
    }
  }, [key, desired, resizing]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      // Ciągnięcie liczy się dopiero powyżej progu drgania ręki — inaczej dwa
      // szarpnięcia w tym samym miejscu wyglądają jak dwuklik i kasują wybraną
      // szerokość (`onDoubleClick`).
      if (Math.abs(deltaX) > 2) movedRef.current = true;
      setDesired(panelWidthFromDrag(drag.startWidth, deltaX, side, clampRef.current));
    };
    const onStop = (event: PointerEvent) => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onStop);
    window.addEventListener("pointercancel", onStop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onStop);
      window.removeEventListener("pointercancel", onStop);
      // Przerwane ciągnięcie (panel zamknięty w trakcie) nie zostawia
      // kursora col-resize i zablokowanego zaznaczania na całej aplikacji.
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, [side]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Drugi palec na tym samym uchwycie nadpisałby trwający gest, a wtedy
      // `pointerup` pierwszego przestaje pasować i ciągnięcie się zacina.
      if (event.button !== 0 || dragRef.current) return;
      event.preventDefault();
      // `preventDefault` zabiera fokus, a bez niego klawiatura (Home/End,
      // strzałki) i obrys `focus-visible` są dostępne wyłącznie tabem.
      event.currentTarget.focus?.();
      movedRef.current = false;
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
      setResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [width],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const grow = side === "left" ? "ArrowLeft" : "ArrowRight";
      const shrink = side === "left" ? "ArrowRight" : "ArrowLeft";
      const next =
        event.key === "Home"
          ? min
          : event.key === "End"
            ? max
            : event.key === grow
              ? width + KEYBOARD_STEP
              : event.key === shrink
                ? width - KEYBOARD_STEP
                : null;
      if (next == null) return;
      event.preventDefault();
      setDesired(clampRef.current(next));
    },
    [max, min, side, width],
  );

  /** Dwuklik wraca do domyślnej — ale tylko jeśli to naprawdę był klik.
   * Dwa szarpnięcia w tym samym miejscu też dają `dblclick`, a wtedy reset
   * kasowałby właśnie ustawianą szerokość. */
  const onDoubleClick = useCallback(() => {
    if (movedRef.current) return;
    setDesired(clampRef.current(defaultWidth));
  }, [defaultWidth]);

  return { width, resizing, side, label, min, max, setWidth, onPointerDown, onKeyDown, onDoubleClick };
}

/** Pasek do chwytania na krawędzi panelu. Ta sama grubość i podświetlenie co
 * w szynie botów, `touch-none` żeby palec ciągnął zamiast przewijać.
 *
 * `WebkitAppRegion: no-drag` jest OBOWIĄZKOWY: w oknie bez ramki nagłówek
 * panelu (`data-shell-header`) jest uchwytem do przeciągania okna i ma 72 px
 * wysokości na całą szerokość panelu, więc bez tego górne 72 px uchwytu
 * przesuwałoby okno zamiast zmieniać szerokość. Chromium składa regiony
 * w kolejności drzewa, więc uchwyt musi stać PO nagłówku (patrz `SidePanel`). */
export function ResizeHandle({ resize, className }: { resize: ResizableWidth; className?: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={resize.min}
      aria-valuemax={resize.max}
      aria-valuenow={resize.width}
      aria-label={resize.label}
      tabIndex={0}
      onPointerDown={resize.onPointerDown}
      onKeyDown={resize.onKeyDown}
      onDoubleClick={resize.onDoubleClick}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      className={cn(
        "group absolute inset-y-0 z-20 flex w-2 cursor-col-resize touch-none items-center justify-center",
        resize.side === "left" ? "left-0" : "right-0",
        className,
      )}
    >
      <span className="h-full w-px bg-transparent transition-colors group-focus-visible:bg-accent" />
    </div>
  );
}

/** Wspólna rama panelu bocznego obok czatu: `<aside>` o zapamiętanej
 * szerokości plus uchwyt. Zawartość paneli zostaje nietknięta.
 *
 * Szerokość idzie zmienną `--panel-width` i KLASĄ `w-[var(--panel-width)]`
 * (poniżej, w bazie), a NIE stylem `width` wprost. Styl inline wygrywa
 * z arkuszem, a układ telefonu (`styles.css`, `max-width: 700px`) musi móc
 * nadpisać szerokość na `100%`. Panel, który na telefonie ma być pełnoekranowy
 * i kolumną dopiero od `md:` (tak działa kopia mobilna), podaje w swoim
 * `className` `w-full md:w-[var(--panel-width)]` — `twMerge` zdejmie wtedy
 * klasę z bazy, bo `w-full` jest z tej samej grupy. */
export function SidePanel({
  storageKey,
  defaultWidth,
  label,
  className,
  handleClassName,
  children,
  ...aside
}: {
  storageKey: string;
  defaultWidth: number;
  label: string;
  className?: string;
  /** Kopia mobilna chowa uchwyt na telefonie: `hidden md:flex`. */
  handleClassName?: string;
  children: React.ReactNode;
  /** Reszta idzie na `<aside>` — panel umiejętności wiesza tu upuszczanie plików. */
} & Omit<React.ComponentPropsWithoutRef<"aside">, "className" | "children" | "style">) {
  const resize = useResizableWidth(storageKey, { defaultWidth, label });
  return (
    <aside
      {...aside}
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col bg-panel w-[var(--panel-width)]",
        className,
      )}
      style={{ "--panel-width": `${resize.width}px` } as React.CSSProperties}
    >
      {children}
      {/* Uchwyt PO zawartości: w oknie bez ramki Chromium składa regiony
          `-webkit-app-region` w kolejności drzewa, więc postawiony wyżej
          zostałby przykryty uchwytem do przeciągania okna z nagłówka panelu. */}
      <ResizeHandle resize={resize} className={handleClassName} />
    </aside>
  );
}
