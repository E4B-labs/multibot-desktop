// multibot (U28): powiadomienia push na telefon, gdy bot wchodzi w
// `needsAttention`. Tokeny Expo trzymamy w configu (`pushDevices`); wysyłka
// idzie przez exp.host — Expo nie wymaga uwierzytelnienia dla tokenów, które
// sam wydał, więc żadnego klucza ani pakietu tu nie ma (chyba że projekt ma
// włączone „Enhanced Security for Push Notifications" — wtedy `EXPO_ACCESS_TOKEN`).
//
// Rejestracja: aplikacja mobilna POSTuje token przez route
// `POST /api/devices/:id/push`. Wysyłka: `notifyPushDevices` wołane z
// `server/index.ts` w momencie ustawienia `needsAttention`.
import { loadConfig, saveConfig, type AppConfig, type PushDevice } from "./config.ts";

export type PushKind =
  | "question" | "handoff" | "approval" | "started"
  | "finished" | "failed" | "attention" | "reminder" | "notify";
export type PushOrigin = "user" | "routine" | "bot";
/** Prośby, na które odpowiada CZŁOWIEK, i przypomnienia, o które sam prosił —
 * warte brzęku nawet w środku pracy bot-bot. Reszta rodzajów to relacja z
 * pracy i czeka na otwarcie apki. */
const ALWAYS = new Set<PushKind>(["question", "handoff", "approval", "attention", "reminder"]);
/**
 * JEDNA reguła „czy to warte powiadomienia". Start tury nie jest zdarzeniem:
 * człowiek sam ją zaczął albo zaczął ją inny bot. Gadanie botów między sobą
 * też nie — do jego czytania nikt nie jest potrzebny. Zostaje odpowiedź dla
 * człowieka w JEGO czacie, przypomnienie i prośba o zgodę / sekret / decyzję.
 */
export function shouldNotify(event: { kind: PushKind; origin?: PushOrigin }): boolean {
  if (event.kind === "started") return false;
  if (event.origin === "bot") return ALWAYS.has(event.kind);
  return true;
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
// Pushe, na które ktoś ma odpowiedzieć, żyją dobę; informacja o starcie albo
// końcu tury po godzinie jest nieaktualna, więc nie ma po co jej dostarczać.
const LONG_TTL_KINDS = new Set(["question", "handoff", "approval", "attention", "reminder"]);
const SHORT_TTL_S = 3600;
const LONG_TTL_S = 24 * 3600;
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
  const ttl = LONG_TTL_KINDS.has(data?.kind ?? "") ? LONG_TTL_S : SHORT_TTL_S;
  // urządzenia, których Expo już nie zna — kasujemy je po pętli, jednym zapisem
  const stale: string[] = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const messages = chunk.map(([, d]) => ({
      to: d.token,
      title,
      body,
      priority: PRIORITY,
      channelId: ANDROID_CHANNEL,
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
