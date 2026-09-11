// multibot (U28): powiadomienia push na telefon. Telefon brzęczy tylko wtedy,
// gdy bot CZEGOŚ CHCE od człowieka albo człowiek sam o to poprosił — bramkę
// trzyma `shouldNotify` niżej.
// Tokeny Expo trzymamy w configu (`pushDevices`); wysyłka
// idzie przez exp.host — Expo nie wymaga uwierzytelnienia dla tokenów, które
// sam wydał, więc żadnego klucza ani pakietu tu nie ma (chyba że projekt ma
// włączone „Enhanced Security for Push Notifications" — wtedy `EXPO_ACCESS_TOKEN`).
//
// Rejestracja: aplikacja mobilna POSTuje token przez route
// `POST /api/devices/:id/push`. Wysyłka: `notifyPushDevices` wołane z
// `server/index.ts` przez `pushForBot`.
import { loadConfig, saveConfig, type AppConfig, type PushDevice } from "./config.ts";

export type PushKind =
  | "question" | "handoff" | "approval" | "started"
  | "finished" | "failed" | "attention" | "reminder" | "notify";
/** Bot stoi i CZEKA na człowieka: pytanie (`ask_user`), zgoda na akcję,
 *  przekazanie komputera, prośba o sekret, wygasłe logowanie do CLI. To jest
 *  baseline Grok Bota — „only come back when something needs your approval". */
const WANTS_USER: readonly PushKind[] = ["question", "handoff", "approval", "attention"];
/** O te dwa poprosił człowiek (przypomnienie) albo sam bot narzędziem
 *  `notify_user` (limitowanym przez `allowNotify`). */
const ASKED_FOR: readonly PushKind[] = ["reminder", "notify"];
/**
 * JEDNA reguła „czy to w ogóle leci na telefon" (Kacper, K4, 11.09.2026).
 *
 * Brzęczy tylko to, na co człowiek ma ODPOWIEDZIEĆ, plus to, o co sam poprosił.
 * Cykl życia tury — `started`, `finished`, `failed` — milczy ZAWSZE, i to
 * właśnie dlatego **rutyna nie powiadamia o każdym przebiegu**: rutyna, która
 * po cichu zrobiła swoje, kończy się `finished` i nie budzi telefonu. Rutyna,
 * która o coś PYTA albo zawoła `notify_user`, budzi — bo wtedy praca stanęła
 * na człowieku.
 *
 * Dlatego bramka nie potrzebuje pochodzenia tury (`origin`): rodzaj zdarzenia
 * rozstrzyga sam, a tury bot↔bot odcina wcześniej `endTurnPush` w
 * `server/index.ts`. Karta w turze izolowanej (grupa, pokój) brzęczy celowo —
 * o odpowiedź prosi człowieka, nie drugiego bota.
 */
const PUSHES = new Set<PushKind>([...WANTS_USER, ...ASKED_FOR]);

export function shouldNotify(kind: PushKind): boolean {
  return PUSHES.has(kind);
}

/** Android grupuje powiadomienia po kanale, więc kanał niesie RODZAJ sprawy:
 *  osobno to, na co trzeba odpowiedzieć, osobno przypomnienia. Dzięki temu da
 *  się wyciszyć jedno bez drugiego w ustawieniach Androida. Kanału, którego
 *  aplikacja nie założyła, Expo nie zgubi — podmienia go na swój zapasowy
 *  (IMPORTANCE_HIGH), więc starsze APK dostają powiadomienie tak jak dotąd. */
export function channelForKind(kind: PushKind | undefined): string {
  if (kind === "reminder") return "reminders";
  return kind && PUSHES.has(kind) ? "asks" : ANDROID_CHANNEL;
}

/** Bramka antyspamowa dla `notify_user`: jeden push na bota na 10 minut.
 * Nadmiarowe wołania sklejają się — bot dostaje „ok", człowiek jednego
 * brzęczyka. Bez tego pętla bota zamieniłaby jedyny wyjątek od ciszy w spam. */
export const NOTIFY_GAP_MS = 10 * 60_000;
const lastNotifyAt = new Map<string, number>();

export function allowNotify(botId: string, now = Date.now()): boolean {
  const last = lastNotifyAt.get(botId);
  if (last !== undefined && now - last < NOTIFY_GAP_MS) return false;
  lastNotifyAt.set(botId, now);
  return true;
}

/** Dedup kart: JEDEN brzęczyk na rodzaj prośby na bota w krótkim oknie.
 * Tura, w której bot prosi o osiem zgód po kolei, i runda grupy dwunastu botów
 * dawały dwanaście powiadomień o tym samym — telefon robił się młotkiem.
 * Karty zostają wszystkie (dokłada je `store.appendMessage`, nie ta bramka),
 * znika tylko powtórzony brzęczyk.
 *
 * Nie dotyczy `reminder` (człowiek sam ustawił godzinę — tego nie wolno
 * połknąć) ani `notify` (ma własne, ostrzejsze okno `allowNotify`) ani
 * `attention`, którego pilnuje stan `needsAttention` na rekordzie bota:
 * powtórka tej samej prośby o logowanie nie brzęczy w ogóle, niezależnie od
 * czasu. */
export const PUSH_DEDUP_MS = 30_000;
const DEDUPED: readonly PushKind[] = ["question", "handoff", "approval"];
const lastCardPushAt = new Map<string, number>();

export function allowCardPush(botId: string, kind: PushKind, now = Date.now()): boolean {
  if (!DEDUPED.includes(kind)) return true;
  const key = `${botId}:${kind}`;
  const last = lastCardPushAt.get(key);
  if (last !== undefined && now - last < PUSH_DEDUP_MS) return false;
  lastCardPushAt.set(key, now);
  return true;
}

/** Tylko dla testów: czyści okna limitów. */
export function resetNotifyLimit(): void {
  lastNotifyAt.clear();
  lastCardPushAt.clear();
}

export function registerPushDevice(id: string, token: string, botId?: string, userId?: string): void {
  const cfg = loadConfig();
  const devices: Record<string, PushDevice> = { ...(cfg.pushDevices ?? {}) };
  devices[id] = { token, botId, userId, updated: Date.now() };
  // saveConfig merguje po kluczu, więc zapis jednego urządzenia nie kasuje reszty
  saveConfig({ pushDevices: devices } as Partial<AppConfig>);
}

// Android: bez `channelId` FCM wrzuca powiadomienie do kanału domyślnego apki,
// a ten po instalacji bywa cichy i bez „heads-up". Aplikacja mobilna zakłada
// kanał `default` (importance HIGH + dźwięk), więc nazwa musi się zgadzać.
const ANDROID_CHANNEL = "default";
// `priority: "high"` budzi urządzenie w Dozie — inaczej Android zbiera pushe
// i dostarcza je dopiero w oknie konserwacyjnym, czyli kilkanaście minut później.
const PRIORITY = "high";
// Po zawężeniu bramki na telefon idą już tylko przypomnienia i `notify_user` —
// jedno i drugie warto dostarczyć nawet po dniu bez zasięgu, więc TTL jest
// jeden. (Wcześniej krótsze TTL dotyczyło relacji z pracy, która dziś milczy.)
const TTL_S = 24 * 3600;
/** exp.host przyjmuje najwyżej 100 wiadomości na żądanie. */
const BATCH = 100;
const TIMEOUT_MS = 10_000;

type PushTicket = { status?: string; message?: string; details?: { error?: string } };
type PushResponse = { data?: PushTicket[]; errors?: { code?: string; message?: string }[] };

export async function notifyPushDevices(
  title: string,
  body: string,
  botId?: string,
  data?: Record<string, string>,
  audienceUserIds?: string[],
  channel?: string,
): Promise<void> {
  const cfg = loadConfig();
  const devices = cfg.pushDevices ?? {};
  const targets = Object.entries(devices).filter(
    ([, d]) =>
      d.token &&
      (botId == null || d.botId == null || d.botId === botId) &&
      (audienceUserIds === undefined ? true : Boolean(d.userId && audienceUserIds.includes(d.userId))),
  );
  if (targets.length === 0) return;

  const url = process.env.MULTIBOT_EXPO_PUSH_URL || "https://exp.host/--/api/v2/push/send";
  const accessToken = process.env.EXPO_ACCESS_TOKEN;
  const ttl = TTL_S;
  // urządzenia, których Expo już nie zna — kasujemy je po pętli, jednym zapisem
  const stale: string[] = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const messages = chunk.map(([, d]) => ({
      to: d.token,
      title,
      body,
      priority: PRIORITY,
      // kanał niesie rodzaj sprawy (`channelForKind`); `data.kind` ustawia
      // `pushForBot`, a wywołania bez niego zostają na kanale domyślnym.
      // `channel` podaje wołający, gdy `data.kind` nie opisuje kanału —
      // komunikat serwera o zmianie adresu nie jest prośbą bota.
      channelId: channel ?? channelForKind(data?.kind as PushKind | undefined),
      sound: "default",
      ttl,
      ...(data ? { data } : {}),
    }));
    let tickets: PushTicket[] = [];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const payload = (await res.json()) as PushResponse;
      for (const error of payload.errors ?? []) {
        console.warn(`[push] exp.host odrzucił żądanie: ${error.code ?? "Unknown"} ${error.message ?? ""}`.trim());
      }
      tickets = Array.isArray(payload.data) ? payload.data : [];
    } catch (error) {
      // timeout, brak sieci, HTML zamiast JSON — push nigdy nie wywraca tury
      console.warn(`[push] wysyłka nieudana: ${(error as Error).message}`);
      continue;
    }
    // tickety wracają w kolejności wiadomości, więc indeks wskazuje urządzenie
    tickets.forEach((ticket, index) => {
      if (ticket?.status !== "error") return;
      const code = ticket.details?.error ?? "Unknown";
      const deviceId = chunk[index]?.[0];
      if (code === "DeviceNotRegistered") {
        if (deviceId) stale.push(deviceId);
        return;
      }
      // nigdy nie logujemy tokenu — po id urządzenia i tak wiadomo, o które chodzi
      console.warn(`[push] ${code} dla urządzenia ${deviceId ?? "?"}: ${ticket.message ?? ""}`.trim());
    });
  }

  // `undefined` w wartości kasuje wpis — patrz merge po kluczu w saveConfig
  if (stale.length > 0) {
    saveConfig({ pushDevices: Object.fromEntries(stale.map((id) => [id, undefined])) } as unknown as Partial<AppConfig>);
  }
}
