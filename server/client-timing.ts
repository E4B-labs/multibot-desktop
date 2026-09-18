// multibot: raporty startu interfejsu, jedna linia JSON na start, z każdego
// urządzenia. Plik `<dataDir>/client-timing.jsonl`, najstarsze wpisy wypadają.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CLIENT_TIMING_MAX_LINES = 500;

export type ClientTimingEntry = {
  origin: string;
  userAgent: string;
  steps: Array<{ name: string; ms: number; durMs?: number }>;
  totalMs: number;
  at: string;
  fromCache?: boolean;
};

/** Ciało z sieci → wpis albo null. Pola tekstowe przycięte, kroki max 100. */
export function parseClientTiming(body: any): ClientTimingEntry | null {
  if (!body || typeof body !== "object" || !Array.isArray(body.steps)) return null;
  const totalMs = Number(body.totalMs);
  if (!Number.isFinite(totalMs) || totalMs < 0) return null;
  const steps = body.steps
    .slice(0, 100)
    .filter((s: any) => s && typeof s.name === "string" && Number.isFinite(Number(s.ms)))
    .map((s: any) => ({
      name: String(s.name).slice(0, 120),
      ms: Math.round(Number(s.ms)),
      ...(Number.isFinite(Number(s.durMs)) ? { durMs: Math.round(Number(s.durMs)) } : {}),
    }));
  const at = typeof body.at === "string" && !Number.isNaN(Date.parse(body.at)) ? body.at : new Date().toISOString();
  return {
    origin: String(body.origin ?? "").slice(0, 200),
    userAgent: String(body.userAgent ?? "").slice(0, 300),
    steps,
    totalMs: Math.round(totalMs),
    at,
    ...(typeof body.fromCache === "boolean" ? { fromCache: body.fromCache } : {}),
  };
}

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

export function appendClientTiming(file: string, entry: ClientTimingEntry, max = CLIENT_TIMING_MAX_LINES): void {
  // ponytail: cały plik czytany przy każdym zapisie; przy 500 liniach to kilobajty
  const lines = [...readLines(file), JSON.stringify(entry)].slice(-max);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
}

/** Ostatnie `limit` wpisów, najnowszy pierwszy; uszkodzone linie pomijane. */
export function readClientTiming(file: string, limit = 20): ClientTimingEntry[] {
  const out: ClientTimingEntry[] = [];
  for (const line of readLines(file).reverse()) {
    if (out.length >= limit) break;
    try {
      const parsed = parseClientTiming(JSON.parse(line));
      if (parsed) out.push(parsed);
    } catch {
      /* zła linia — pomijamy */
    }
  }
  return out;
}
