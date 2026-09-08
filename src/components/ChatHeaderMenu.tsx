// multibot: pięć akcji bota pod jednym przyciskiem „⋮" na końcu nagłówka
// czatu — tuż na lewo od kontrolek okna, z pigułką modelu obok. Odwzorowanie
// aplikacji mobilnej (multibot-mobile/webui/src/components/ChatView.tsx): ta sama
// kolejność pozycji i te same etykiety.
//
// Kolor kropek mówi wyłącznie o tym, czy menu jest rozwinięte: niebieskie gdy
// otwarte, szare gdy zamknięte. Otwarty panel bota NIE podświetla przycisku —
// tak jest na telefonie.
//
// Otwarcie gra sekwencję na 0,6 s (Kacper 29.08), po 0,2 s na fazę:
//   1. panel rozwija się jak zwój, od góry do dołu, jeszcze pusty,
//   2. z przycisku „⋮" wylatuje pięć kropek i siada na miejscach ikon,
//   3. z każdej kropki wychodzi w prawo etykieta, litera po literze.
// Skracane dwa razy: najpierw z 1 s na 0,5 s, potem na 0,2 s — przy dłuższych
// czasach menu wyraźnie zwlekało z otwarciem.
// Po sekwencji panel renderuje się dokładnie tak jak przedtem — bez opakowań
// na litery i bez klas animacji, żeby stan końcowy był identyczny.
//
// Tylko pulpit: w przeglądarce i na serwerze telefonu nagłówek zostaje
// z pięcioma ikonami, bo tam nic ich nie ściska.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CalendarClock, MessagesSquare, Monitor, MoreVertical, ScanSearch, Search, Users, Wand2 } from "lucide-react";
import { useStore } from "@/state/store";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/cn";
import { motionIsReduced } from "@/lib/motion";

/** Kolejność jak na telefonie. Lista jest jawna, żeby po schowaniu ikon żadna
 * funkcja nie wyparowała — pilnuje tego ChatHeaderMenu.test.ts. */
const ALL_CHAT_HEADER_ACTIONS = ["computer", "routines", "skills", "find", "inspector", "rooms", "team"] as const;
export type ChatHeaderAction = (typeof ALL_CHAT_HEADER_ACTIONS)[number];
/** hidden per Kacper 07.09.2026, panels kept */
export const HIDDEN_CHAT_HEADER_ACTIONS: readonly ChatHeaderAction[] = ["inspector", "rooms", "team"];
export const CHAT_HEADER_ACTIONS: readonly ChatHeaderAction[] = ALL_CHAT_HEADER_ACTIONS.filter(
  (action) => !HIDDEN_CHAT_HEADER_ACTIONS.includes(action),
);

/** Czasy faz. Te same liczby stoją w klatkach CSS (src/styles.css:
 * menu-unroll, menu-dot-fly, menu-letter-in) i muszą się zgadzać —
 * rozjazd widać jako przeskok w połowie ruchu. */
export const UNROLL_MS = 200;
export const FLY_MS = 200;
export const TYPE_MS = 200;
/** Ile trwa pojawienie się jednej litery. Reszta okna to rozjazd opóźnień —
 * przy 0,2 s na całą fazę zostaje go 0,12 s. Litera musi więc być bardzo
 * krótka, inaczej wszystkie zapaliłyby się naraz i efekt pisania by zniknął. */
export const LETTER_MS = 80;

export type MenuPhase = "unroll" | "fly" | "type" | "done";

/** Opóźnienie litery `index` z `count`, w sekundach. Pierwsza rusza od razu,
 * ostatnia startuje tak, żeby skończyć równo z końcem fazy — niezależnie od
 * długości etykiety, więc wszystkie pozycje kończą pisanie w tej samej chwili. */
export function letterDelay(index: number, count: number): number {
  if (count <= 1) return 0;
  const span = TYPE_MS - LETTER_MS;
  const step = Math.min(Math.max(index, 0), count - 1) / (count - 1);
  return (step * span) / 1000;
}

export function ChatHeaderMenu({ onToggleFind }: { onToggleFind: () => void }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const slotRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<MenuPhase>("done");
  const [offsets, setOffsets] = useState<Array<{ dx: number; dy: number }>>([]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Sekwencja faz. Kto prosi system o mniej ruchu, dostaje panel od razu gotowy.
  useEffect(() => {
    if (!open) return;
    if (motionIsReduced()) {
      setPhase("done");
      return;
    }
    setPhase("unroll");
    const toFly = setTimeout(() => setPhase("fly"), UNROLL_MS);
    const toType = setTimeout(() => setPhase("type"), UNROLL_MS + FLY_MS);
    const toDone = setTimeout(() => setPhase("done"), UNROLL_MS + FLY_MS + TYPE_MS);
    return () => {
      clearTimeout(toFly);
      clearTimeout(toType);
      clearTimeout(toDone);
    };
  }, [open]);

  // Skąd dokąd lecą kropki. Mierzone z układu, nie wpisane na sztywno — inna
  // czcionka albo inny odstęp w wierszu i tak trafią w środek ikony.
  useLayoutEffect(() => {
    if (!open) return;
    const from = triggerRef.current?.getBoundingClientRect();
    if (!from) return;
    const cx = from.left + from.width / 2;
    const cy = from.top + from.height / 2;
    setOffsets(
      CHAT_HEADER_ACTIONS.map((_, i) => {
        const slot = slotRefs.current[i]?.getBoundingClientRect();
        if (!slot) return { dx: 0, dy: 0 };
        return { dx: cx - (slot.left + slot.width / 2), dy: cy - (slot.top + slot.height / 2) };
      }),
    );
  }, [open]);

  const entries: Record<ChatHeaderAction, { icon: typeof Monitor; label: string; run: () => void }> = {
    computer: {
      icon: Monitor,
      label: polish ? "Komputer bota" : "Bot's computer",
      run: () => dispatch({ type: "toggleComputer" }),
    },
    routines: {
      icon: CalendarClock,
      label: polish ? "Rutyny bota" : "Bot routines",
      run: () => dispatch({ type: "toggleRoutines" }),
    },
    skills: {
      icon: Wand2,
      label: polish ? "Umiejętności bota" : "Bot skills",
      run: () => dispatch({ type: "toggleSkills" }),
    },
    find: {
      icon: Search,
      label: polish ? "Szukaj w rozmowie" : "Find in chat",
      run: onToggleFind,
    },
    inspector: {
      icon: ScanSearch,
      label: polish ? "Inspector runtime" : "Runtime inspector",
      run: () => dispatch({ type: "toggleInspector" }),
    },
    rooms: {
      icon: MessagesSquare,
      label: polish ? "Rozmowy botów" : "Bot rooms",
      run: () => dispatch({ type: "toggleRooms", open: true }),
    },
    team: {
      icon: Users,
      label: polish ? "Mapa zespołu" : "Team map",
      run: () => dispatch({ type: "toggleTeamMap", open: true }),
    },
  };

  const done = phase === "done";

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "rounded-md p-1.5 hover:bg-raised",
          open ? "text-accent" : "text-ink-secondary hover:text-ink",
        )}
        title={polish ? "Więcej" : "More"}
        aria-label={polish ? "Więcej" : "More"}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <MoreVertical size={18} />
      </button>
      {open && (
        <div
          role="menu"
          data-menu-phase={phase}
          className={cn(
            "absolute right-0 top-full z-30 mt-1.5 w-48 rounded-xl border border-hairline/40 bg-card p-1 shadow-lg",
            // Zwój tylko w pierwszej fazie: klasa znika razem z przycięciem,
            // więc kropki mogą potem lecieć spoza obrysu panelu.
            phase === "unroll" && "menu-unroll",
          )}
        >
          {CHAT_HEADER_ACTIONS.map((key, row) => {
            const { icon: Icon, label, run } = entries[key];
            const offset = offsets[row] ?? { dx: 0, dy: 0 };
            return (
              <button
                key={key}
                role="menuitem"
                onClick={() => {
                  run();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink hover:bg-raised"
              >
                <span
                  ref={(el) => {
                    slotRefs.current[row] = el;
                  }}
                  className="relative flex size-4 shrink-0 items-center justify-center"
                >
                  {/* Kropka leci z „⋮" na to miejsce; ikona siada dopiero po niej. */}
                  {phase === "fly" && (
                    <span
                      aria-hidden
                      className="menu-dot absolute size-1.5 rounded-full bg-accent"
                      style={
                        {
                          "--dot-dx": `${offset.dx}px`,
                          "--dot-dy": `${offset.dy}px`,
                        } as React.CSSProperties
                      }
                    />
                  )}
                  <Icon
                    size={16}
                    className={cn(
                      "text-ink",
                      (phase === "unroll" || phase === "fly") && "opacity-0",
                      phase === "type" && "menu-icon-in",
                    )}
                  />
                </span>
                {done ? (
                  <span>{label}</span>
                ) : (
                  // Litera po literze, od lewej. Opakowania znikają po
                  // sekwencji, żeby napis wrócił do jednego węzła tekstowego.
                  <span className={cn(phase !== "type" && "opacity-0")}>
                    {[...label].map((char, i) => (
                      <span
                        key={i}
                        className={cn("whitespace-pre", phase === "type" && "menu-letter")}
                        style={
                          phase === "type"
                            ? ({ animationDelay: `${letterDelay(i, label.length)}s` } as React.CSSProperties)
                            : undefined
                        }
                      >
                        {char}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
