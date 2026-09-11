export interface OrderedMessage {
  id: string;
  at: number;
  order?: number;
}

/** K7: union of two transcript slices by id — `incoming` wins on a duplicate
 *  (it is the newer server state, e.g. a settled card). Order is NOT restored
 *  here; callers pass the result through `sortMessages`. */
export function mergeMessages<T extends OrderedMessage>(kept: readonly T[], incoming: readonly T[]): T[] {
  if (kept.length === 0) return [...incoming];
  const seen = new Set(incoming.map((m) => m.id));
  return [...kept.filter((m) => !seen.has(m.id)), ...incoming];
}

/** Keep every client deterministic when live SSE frames arrive out of order. */
export function sortMessages<T extends OrderedMessage>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => a.at - b.at || (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
}
