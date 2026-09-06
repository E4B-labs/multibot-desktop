// multibot: ikony szyny sekcji w ustawieniach, przerysowane z lucide, żeby
// dało się ruszać ich częściami. Geometria jest kopią oryginałów
// (sliders-horizontal, refresh-cw, wrench) w tej samej siatce 24x24 i z tą
// samą grubością kreski, więc bez animacji wyglądają identycznie jak dotąd.
//
// Jedna różnica względem lucide: suwaki mają pełne poziome szyny zamiast
// dwóch odcinków przerwanych pod gałką. Lucide robi tę przerwę, bo gałka
// stoi w miejscu — u nas jeździ po szynie, a przerwa jeździłaby razem z nią
// i zostawiała dziurę w torze.
//
// Ruch siedzi w CSS (src/styles.css, klatki settings-*) i włącza go atrybut
// data-playing. Rodzic przemontowuje ikonę przez key, więc kolejne kliknięcie
// w tę samą sekcję puszcza animację od nowa.

type Props = { size?: number; className?: string; playing?: boolean };

function frame({ size = 19, className, playing }: Props, children: React.ReactNode) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      data-settings-tab-icon
      data-playing={playing ? "" : undefined}
    >
      {children}
    </svg>
  );
}

/** Suwaki: trzy szyny, trzy gałki jeżdżące po nich w poziomie. */
export function SlidersTabIcon(props: Props) {
  return frame(
    props,
    <>
      <line x1="3" x2="21" y1="4" y2="4" />
      <line x1="3" x2="21" y1="12" y2="12" />
      <line x1="3" x2="21" y1="20" y2="20" />
      <line className="settings-slider-knob settings-slider-knob--1" x1="14" x2="14" y1="2" y2="6" />
      <line className="settings-slider-knob settings-slider-knob--2" x1="8" x2="8" y1="10" y2="14" />
      <line className="settings-slider-knob settings-slider-knob--3" x1="16" x2="16" y1="18" y2="22" />
    </>,
  );
}

/** Odświeżanie: obie strzałki kręcą się wokół środka ikony. */
export function RefreshTabIcon(props: Props) {
  return frame(
    props,
    <g className="settings-refresh-spin">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </g>,
  );
}

/** Klucz: kołysze się wokół własnej główki, więc rączka chodzi góra-dół,
 *  jakby dokręcał, a sama główka zostaje na miejscu. */
export function WrenchTabIcon(props: Props) {
  return frame(
    props,
    <g className="settings-wrench-turn">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
    </g>,
  );
}

/** Tarcza admina: kabłąk stoi, a "sprawdzenie" przebiega przez środek —
 *  ten sam gest co ptaszek w lucide `shield-check`. */
export function ShieldTabIcon(props: Props) {
  return frame(
    props,
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path className="settings-shield-check" d="m9 12 2 2 4-4" />
    </>,
  );
}
