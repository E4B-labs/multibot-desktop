// multibot: ochrona optymistycznych edycji bota przed spóźnionym echem
// serwera. Szybkie klikanie (np. kształt awatara) wygląda tak: klik A →
// debounce → PATCH A → klik B (optymistycznie B) → echo {kind:"bot"} z A
// nadpisuje B → PATCH B → echo B. Efekt: nowy → stary → nowy.
//
// Rozwiązanie: każde lokalne `updateBot` znaczy edytowane pola rosnącym
// licznikiem. Dopóki najnowszy PATCH obejmujący dane pole nie wróci z
// serwera, echa (botPatched z kanału zdarzeń) mają te pola WYCIĘTE —
// lokalny zamiar wygrywa. Po potwierdzeniu (albo błędzie) pola o numerze
// <= potwierdzonego są zwalniane i serwer znów jest źródłem prawdy.

type FieldSeqs = Map<string, number>;

const pending = new Map<string, FieldSeqs>();
let seq = 0;

/** Zanotuj lokalną edycję pól bota; zwraca numer tej edycji. */
export function noteLocalBotEdit(botId: string, fields: string[]): number {
  const s = ++seq;
  let byField = pending.get(botId);
  if (!byField) {
    byField = new Map();
    pending.set(botId, byField);
  }
  for (const field of fields) byField.set(field, s);
  return s;
}

/**
 * PATCH obejmujący edycje do numeru `upToSeq` zakończył się (sukcesem albo
 * błędem) — zwolnij pola, których od tego czasu nikt nie edytował ponownie.
 */
export function settleLocalBotEdits(botId: string, upToSeq: number): void {
  const byField = pending.get(botId);
  if (!byField) return;
  for (const [field, s] of byField) {
    if (s <= upToSeq) byField.delete(field);
  }
  if (byField.size === 0) pending.delete(botId);
}

/**
 * Wytnij z przychodzącego patcha serwera pola, które mają niepotwierdzoną
 * lokalną edycję — stare echo nie może nadpisać nowszego wyboru.
 */
export function stripPendingBotEcho<T extends { id: string }>(patch: T): T {
  const byField = pending.get(patch.id);
  if (!byField || byField.size === 0) return patch;
  let out: T | null = null;
  for (const field of byField.keys()) {
    if (field === "id" || !(field in patch)) continue;
    if (!out) out = { ...patch };
    delete (out as Record<string, unknown>)[field];
  }
  return out ?? patch;
}

/** Tylko do testów: wyczyść cały stan modułu. */
export function resetPendingBotEdits(): void {
  pending.clear();
  seq = 0;
}
