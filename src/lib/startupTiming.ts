// multibot: pomiar startu aplikacji. Zamiast zgadywać, czemu „wolno się
// otwiera", zbieramy znaczniki od `performance.timeOrigin` do chwili, gdy lista
// botów stoi na ekranie i kanał zdarzeń jest otwarty. Zero zależności; działa
// w przeglądarce, w Electronie i w WebView aplikacji mobilnej (brak
// `performance.mark`, brak Resource Timing = po prostu mniej kroków).

export type StartupStep = { name: string; ms: number; durMs?: number };

export type StartupReport = {
  origin: string;
  userAgent: string;
  steps: StartupStep[];
  totalMs: number;
  at: string;
  fromCache: boolean;
};

/** Podzbiór `performance`, którego używamy — test podaje atrapę. */
export type PerfLike = {
  now(): number;
  mark?(name: string): unknown;
  getEntriesByName?(name: string, type?: string): Array<{ startTime: number }>;
  getEntriesByType?(type: string): any[];
};

const PREFIX = "mb:";
const marks = new Map<string, number>();
let report: StartupReport | null = null;
const readyListeners: Array<(report: StartupReport) => void> = [];

function perf(): PerfLike | null {
  return typeof performance === "undefined" ? null : (performance as PerfLike);
}

/** Jeden znacznik na nazwę: pierwszy zapis wygrywa (reconnect nie nadpisuje startu). */
export function markStartup(name: string, p: PerfLike | null = perf()): void {
  if (!p || marks.has(name)) return;
  marks.set(name, p.now());
  try {
    p.mark?.(PREFIX + name);
  } catch {
    /* WebView bez User Timing — mapa wystarczy */
  }
  if (name !== "ready" && marks.has("events-open") && marks.has("bots-rendered")) {
    markStartup("ready", p);
    report = collectStartup(p, marks);
    for (const listener of readyListeners.splice(0)) listener(report);
  }
}

/** Ścieżka bez originu i query: `/api/bots?x=1` → `/api/bots`. */
function shortName(url: string): string {
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url;
  }
}

/** Czysta funkcja: znaczniki + Resource Timing → raport. Testowalna bez DOM. */
export function collectStartup(p: PerfLike, marksIn: Map<string, number> = marks): StartupReport {
  const steps: StartupStep[] = [];
  const ready = marksIn.get("ready") ?? p.now();
  const nav = p.getEntriesByType?.("navigation")?.[0];
  let fromCache = false;
  if (nav) {
    steps.push({ name: "html", ms: nav.responseEnd, durMs: nav.responseEnd - nav.requestStart });
    fromCache = nav.transferSize === 0 || nav.deliveryType === "cache";
  }
  const resources: any[] = p.getEntriesByType?.("resource") ?? [];
  const script = resources.find((r) => r.initiatorType === "script" && /\.js(\?|$)/.test(r.name));
  if (script) steps.push({ name: "bundle " + shortName(script.name).split("/").pop(), ms: script.responseEnd, durMs: script.duration });
  const apiCalls = resources
    .filter((r) => shortName(r.name).startsWith("/api/") && r.startTime <= ready)
    .sort((a, b) => a.startTime - b.startTime);
  if (apiCalls[0]) steps.push({ name: "api-first", ms: apiCalls[0].startTime });
  for (const r of apiCalls) steps.push({ name: "api " + shortName(r.name), ms: r.responseEnd, durMs: r.duration });
  for (const [name, ms] of marksIn) steps.push({ name, ms });
  steps.sort((a, b) => a.ms - b.ms);
  for (const step of steps) {
    step.ms = Math.round(step.ms);
    if (step.durMs !== undefined) step.durMs = Math.round(step.durMs);
  }
  return {
    origin: typeof location === "undefined" ? "" : location.origin,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    steps,
    totalMs: Math.round(ready),
    at: new Date().toISOString(),
    fromCache,
  };
}

/** Raport, gdy start się domknął; do panelu ustawień. */
export function getStartupReport(): StartupReport | null {
  return report;
}

/** Wołane raz, gdy lista botów stoi i kanał zdarzeń działa. */
export function onStartupReady(listener: (report: StartupReport) => void): void {
  if (report) listener(report);
  else readyListeners.push(listener);
}

/** Tekst do schowka i do wklejenia w zgłoszeniu. */
export function formatStartupReport(r: StartupReport): string {
  const lines = [
    `MultiBot start: ${r.totalMs} ms (${r.fromCache ? "cache" : "network"})`,
    `origin: ${r.origin}`,
    `ua: ${r.userAgent}`,
    `at: ${r.at}`,
    ...r.steps.map((s) => `${String(s.ms).padStart(6)} ms  ${s.name}${s.durMs !== undefined ? ` (+${s.durMs} ms)` : ""}`),
  ];
  return lines.join("\n");
}

/** Tylko dla testów: czysty stan modułu. */
export function resetStartupTiming(): void {
  marks.clear();
  report = null;
  readyListeners.length = 0;
}
