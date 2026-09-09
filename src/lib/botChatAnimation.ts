// Wybór partnera „boty rozmawiają między sobą" + generator szlaczków do dymków.
// Celowo bez Reacta i bez DOM: czyste funkcje, które da się sprawdzić w vitest
// (botChatAnimation.test.ts), a komponent (PeerChatIndicator) tylko je woła.
import type { Bot, Room } from "@/state/store";

/** Co ile milisekund dymki zamieniają szlaczki na nową kombinację (~15 s). */
export const PEER_CHAT_WAVE_MS = 15_000;

/** Liczba kształtów fali w puli — od niej zależy rotacja kombinacji. */
export const WAVE_VARIANT_COUNT = 6;

/** Mapa botów floty: id → bot (store trzyma tablicę, komponent ją indeksuje). */
export type BotLookup = Readonly<Record<string, Bot>>;

export interface ActivePeerChat {
  /** pokój, z którego wynika rozmowa */
  roomId: string;
  /** bot pokazywany po prawej od awatara oglądanego bota */
  peerBot: Bot;
  /** bot whose turn is currently being generated in this room */
  activeBotId?: string | null;
}

function lookupBot(bots: BotLookup, id: string): Bot | undefined {
  return Object.prototype.hasOwnProperty.call(bots, id) ? bots[id] : undefined;
}

/**
 * Kto rozmawia z oglądanym botem?
 *
 * Wejście: lista pokoi (w kolejności powstania — tak trzyma ją store), id
 * oglądanego bota i mapa botów. Wyjście: pierwszy AKTYWNY partner albo null.
 *
 * Zasady:
 * - licz się tylko pokoje ze statusem "running" (done/failed animują zniknięcie),
 * - pokój musi zawierać oglądanego bota,
 * - przy kilku równoległych pokojach wygrywa PIERWSZY z listy (decyzja specyfikacji:
 *   jeden partner, bez komplikowania),
 * - partner to pierwszy inny uczestnik obecny w mapie botów; pomijamy boty
 *   usunięte (brak w mapie) i ukryte (`hidden`) — nie wyskakują znikąd.
 */
export function selectActivePeerChat(
  rooms: readonly Room[],
  watchedBotId: string,
  bots: BotLookup,
): ActivePeerChat | null {
  for (const room of rooms) {
    if (room.status !== "running") continue;
    if (!room.bot_ids.includes(watchedBotId)) continue;
    for (const id of room.bot_ids) {
      if (id === watchedBotId) continue;
      const peer = lookupBot(bots, id);
      if (!peer || peer.hidden) continue;
      return { roomId: room.id, peerBot: peer, activeBotId: room.activeBotId };
    }
  }
  return null;
}

/**
 * Czy bot jest W TRAKCIE rozmowy z innym botem?
 *
 * Nie chodzi o „należy do jakiegoś pokoju" (pokój żyje aż go ktoś zamknie albo
 * zmiecie zegar), tylko o wymianę, która NAPRAWDĘ trwa. Trwa, gdy w pokoju
 * dzieje się jedno z dwojga:
 *
 * - `pendingTo` — komuś oddano turę, ale ta jeszcze nie ruszyła (serwer nadaje
 *   pokój przy każdej zmianie tego pola, więc klient widzi też tę szczelinę),
 * - któryś INNY uczestnik jest `busy` — właśnie pisze odpowiedź.
 *
 * Suma tych dwóch pokrywa całą wymianę bez dziur: kiedy jeden bot kończy turę,
 * dług już jest zapisany, a kiedy drugi ją zaczyna, dług znika i zapala się
 * `busy`. Kiedy rozmowa naprawdę cichnie, gaśnie jedno i drugie.
 */
export function isEngagedInPeerChat(
  rooms: readonly Room[],
  watchedBotId: string,
  bots: BotLookup,
): boolean {
  return rooms.some(
    (room) =>
      room.status === "running" &&
      // Pokój grupy to czat CZŁOWIEKA, nie rozmowa botów: bot odpowiadający w
      // grupie nie jest powodem, żeby prywatny czat jego kolegi nasłuchiwał.
      !room.groupId &&
      room.bot_ids.includes(watchedBotId) &&
      (Boolean(room.pendingTo) ||
        room.bot_ids.some((id) => id !== watchedBotId && lookupBot(bots, id)?.busy === true)),
  );
}

/**
 * Stabilne ziarno per pokój (FNV-1a). Świadomie bez Math.random: te same dane
 * muszą dać tę samą kombinację fal, inaczej test determinizmu nie ma sensu.
 */
export function waveSeed(roomId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < roomId.length; i++) {
    hash ^= roomId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Poziome szlaczki imitujące tekst rozmowy, w pudełku 48×18. Każdy kształt to
 * JEDNA linia na zadanej wysokości — dymek składa z nich dwie linie (górną
 * i dolną), a cała para zmienia się co PEER_CHAT_WAVE_MS.
 */
const round1 = (value: number) => Math.round(value * 10) / 10;

const WAVE_SHAPES: Array<(y: number) => string> = [
  // gładka sinusoida
  (y) => `M4 ${round1(y)} C10 ${round1(y - 3.2)}, 16 ${round1(y + 3.2)}, 24 ${round1(y)} S38 ${round1(y + 3.2)}, 44 ${round1(y)}`,
  // ostry zygzak
  (y) => `M4 ${round1(y + 2.6)} L11 ${round1(y - 2.6)} L18 ${round1(y + 2.6)} L25 ${round1(y - 2.6)} L32 ${round1(y + 2.6)} L39 ${round1(y - 2.6)} L44 ${round1(y)}`,
  // kreski jak słowa oddzielone spacjami
  (y) => `M5 ${round1(y)} L14 ${round1(y)} M18.5 ${round1(y)} L25 ${round1(y)} M29.5 ${round1(y)} L43 ${round1(y)}`,
  // podwójna częstotliwość — nerwowa, szybka gadanina
  (y) => `M4 ${round1(y)} C7.5 ${round1(y - 4)}, 10.5 ${round1(y + 4)}, 14 ${round1(y)} S20.5 ${round1(y + 4)}, 24 ${round1(y)} S34 ${round1(y - 4)}, 37.5 ${round1(y)} S41 ${round1(y + 3)}, 44 ${round1(y)}`,
  // zaokrąglone schodki — spokojne, przemyślane zdania
  (y) => `M4 ${round1(y + 2)} Q8 ${round1(y + 2)}, 8 ${round1(y - 2)} L22 ${round1(y - 2)} Q26 ${round1(y - 2)}, 26 ${round1(y + 2)} L40 ${round1(y + 2)} Q44 ${round1(y + 2)}, 44 ${round1(y)}`,
  // długa łukowa myśl z kropką na końcu
  (y) => `M4 ${round1(y + 1.5)} Q16 ${round1(y - 4.5)}, 30 ${round1(y + 0.5)} T44 ${round1(y - 1)} M45.5 ${round1(y + 2.5)} L45.6 ${round1(y + 2.6)}`,
];

const mod = (value: number, size: number) => ((value % size) + size) % size;

/**
 * Dwa szlaczki dla jednego dymku.
 *
 * `slot` rozdziela dymki (0 = nad oglądanym botem, 1 = nad partnerem), `tick`
 * rośnie co PEER_CHAT_WAVE_MS i wymusza nową kombinację. Ziarno pokoju sprawia,
 * że każdy room gada innym rytmem. Para wewnątrz dymku jest przesunięta o połowę
 * puli, więc górna i dolna linia nigdy się nie dublują.
 */
export function bubbleWaves(seed: number, slot: number, tick: number): [string, string] {
  const base = mod(seed + tick * 2 + slot * 5, WAVE_VARIANT_COUNT);
  return [WAVE_SHAPES[base](5), WAVE_SHAPES[mod(base + 3, WAVE_VARIANT_COUNT)](13)];
}
