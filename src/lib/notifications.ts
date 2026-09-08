// Browser notifications stay opt-in and never block in-app badges.
export async function requestBrowserNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") return Notification.requestPermission();
  return Notification.permission;
}

// multibot: jedna banerka na bota — nowa podmienia poprzednią (tag per bot),
// zamiast układać się w stos per zdarzenie. Ikona = kolor maskotki bota.
export function notificationTag(botId?: string): string {
  return botId ? `multibot:${botId}` : "multibot";
}

export function botNotificationIcon(color?: string): string | undefined {
  if (typeof document === "undefined" || !color) return undefined;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.beginPath();
    ctx.arc(64, 64, 64, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

export interface NotifyOptions {
  tag?: string;
  icon?: string;
}

export function notifyBrowser(title: string, body: string, opts: NotifyOptions = {}): void {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: opts.tag ?? `multibot:${title}`, icon: opts.icon });
  } catch {
    /* browser denied it */
  }
}

// ── Przełącznik „Powiadomienia na pulpicie" ────────────────────────────
// Lokalny, jak tryb animacji: dotyczy tej powłoki, nie konta. Domyślnie
// włączony — wyłączenie zapisujemy jawnie, żeby brak klucza znaczył „tak".
const DESKTOP_KEY = "multibot-desktop-notifications";

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readDesktopNotifications(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): boolean {
  try {
    return storage?.getItem(DESKTOP_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDesktopNotifications(enabled: boolean): void {
  try {
    browserStorage()?.setItem(DESKTOP_KEY, enabled ? "on" : "off");
  } catch {
    /* storage blocked — the toggle still holds for this session */
  }
}

// ── Kiedy w ogóle pokazać banerkę ──────────────────────────────────────
// Czysta decyzja, bez DOM-u i bez Electrona: cała reguła siedzi tutaj, więc
// da się ją przetestować, a store tylko podaje dwie migawki bota.
export interface NotifySnapshot {
  id: string;
  busy?: boolean;
  unread?: boolean;
  needsAttention?: string | null;
  /** serwer: tura ruszyła od innego bota — jej koniec nie jest wiadomością dla
   * człowieka, więc banerki „skończył" z niej nie ma (push ma tę samą regułę
   * w `server/push.ts`) */
  botTurn?: boolean;
  /** przełącznik per bot z SettingsPanel; brak = nie dotyczy (pokoje) */
  notifications?: boolean;
}

export interface NotifyContext {
  /** czy okno aplikacji jest aktywne */
  focused: boolean;
  /** bot otwarty na ekranie */
  selectedBotId?: string;
  /** globalny przełącznik z ustawień aplikacji */
  enabled: boolean;
}

export type NotifyReason = "attention" | "finished" | null;

export function shouldNotify(
  prev: NotifySnapshot | undefined,
  next: NotifySnapshot,
  ctx: NotifyContext,
): NotifyReason {
  // Bez migawki „przed" nie ma przejścia — pierwsze zobaczenie bota (start
  // aplikacji, resync po rozłączeniu) nigdy nie powiadamia.
  if (!ctx.enabled || next.notifications === false || !prev) return null;
  // Patrzysz na tego bota w aktywnym oknie — widzisz to samo bez banerki.
  if (ctx.focused && ctx.selectedBotId === next.id) return null;
  const attention = next.needsAttention ?? null;
  if (attention && attention !== (prev.needsAttention ?? null)) return "attention";
  if (prev.botTurn) return null;
  const finished = (prev.busy === true && next.busy !== true) || (next.unread === true && prev.unread !== true);
  return finished ? "finished" : null;
}

/** Pokój współpracy zamknął temat: running/failed → done. */
export function shouldNotifyRoomDone(
  prevStatus: string | undefined,
  status: string,
  ctx: { enabled: boolean; viewing?: boolean },
): boolean {
  if (!ctx.enabled || ctx.viewing || prevStatus === undefined) return false;
  return prevStatus !== "done" && status === "done";
}

/** Ramka `notify` z serwera: bot ma coś do powiedzenia TERAZ (przypomnienie,
 * `notify_user`). W odróżnieniu od `shouldNotify` odpala CELOWO także wtedy,
 * gdy patrzysz na tego bota — o banerkę poprosił bot, nie zgadujemy jej z
 * przejścia stanu. Ikonę dokłada wołający, bo zna kolor bota. */
export interface NotifyFrame {
  botId?: string;
  title?: string;
  body?: string;
}

export function notifyFrame(frame: NotifyFrame, ctx: { enabled: boolean }): NotifyPayload | null {
  const title = String(frame?.title ?? "").trim();
  if (!ctx.enabled || !title) return null;
  return { title, body: String(frame?.body ?? "").trim(), botId: frame?.botId };
}

export interface NotifyPayload {
  title: string;
  body: string;
  botId?: string;
  icon?: string;
}

/** Jedno wyjście dla obu powłok: pod Electronem banerkę rysuje proces główny
 *  (kliknięcie potrafi wtedy podnieść okno), w przeglądarce zwykłe API. */
export function notify({ title, body, botId, icon }: NotifyPayload): void {
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.notify;
  if (bridge) {
    bridge({ title, body, botId });
    return;
  }
  notifyBrowser(title, body, { tag: notificationTag(botId), icon });
}
