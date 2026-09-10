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

  const [width, setWidthRaw] = useState(() => readStoredWidth(key, defaultWidth, clampRef.current));
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const setWidth = useCallback((next: number) => setWidthRaw(clampRef.current(next)), []);

  // Okno zwężone po zapisaniu szerokości: panel musi zejść razem z nim,
  // inaczej po zmniejszeniu okna nie widać już czatu.
  useEffect(() => {
    if (fixedMax != null) return;
    const update = () => setMax(viewportMaxWidth(min, window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [fixedMax, min]);

  useEffect(() => {
    setWidthRaw((current) => clampRef.current(current));
  }, [max, min]);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(width));
    } catch {
      // jw. — brak zapisu nie psuje bieżącej sesji
    }
  }, [key, width]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      setWidthRaw(panelWidthFromDrag(drag.startWidth, event.clientX - drag.startX, side, clampRef.current));
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
      if (event.button !== 0) return;
      event.preventDefault();
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
      setWidthRaw(clampRef.current(next));
    },
    [max, min, side, width],
  );

  const onDoubleClick = useCallback(() => setWidthRaw(clampRef.current(defaultWidth)), [defaultWidth]);

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
      <span className="h-full w-px bg-transparent transition-colors group-hover:bg-accent/50 group-focus-visible:bg-accent" />
    </div>
  );
}

/** Wspólna rama panelu bocznego obok czatu: `<aside>` o zapamiętanej
 * szerokości plus uchwyt. Zawartość paneli zostaje nietknięta.
 *
 * Szerokość idzie zmienną `--panel-width`, a NIE stylem `width` wprost — klasę
 * `w-[var(--panel-width)]` wnosi każdy panel w swoim `className`. Dzięki temu
 * ten sam plik działa w kopii mobilnej, gdzie panel na telefonie jest
 * `fixed inset-0 w-full`, a kolumną staje się dopiero od `md:`. */
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
