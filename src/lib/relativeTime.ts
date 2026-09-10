// multibot: „za 2 godz." / „3 minuty temu" w języku aplikacji. Wyciągnięte z
// AdminPanel.tsx, gdy panel przypomnień potrzebował tej samej etykiety —
// czysty formater bez React/DOM, więc importuje go i komponent, i test.
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/** "3 minutes ago" in whichever language the app is in. Timestamps straight
 * from the database mean nothing to the person reading the table. */
export function relativeTime(at: number | undefined | null, now: number, locale: string): string {
  if (!at) return "—";
  const delta = at - now;
  const absolute = Math.abs(delta);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of UNITS) if (absolute >= ms) return format.format(Math.round(delta / ms), unit);
  return format.format(0, "second");
}
