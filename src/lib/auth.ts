// G2: one authenticated transport for every browser request.
const TOKEN_KEY = "multibot.auth.token";
// Native shells cannot keep the `mb_v2_session` cookie their WebView gets, so
// they drop the session token here before the app boots; browser and Electron
// ride the cookie instead.
const SESSION_KEY = "multibot.auth.session";
const AUTH_REQUIRED = "multibot:auth-required";
const REFRESH_PATH = "/api/auth/access-token";

export function getAuthToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    // Bez tego wylogowanie zostawia natywnemu klientowi materiał na wybicie
    // sobie nowego tokenu przy pierwszym 401.
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage can be disabled in private browsing */
  }
}

export function bootstrapLocalAuthToken(): void {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("access_token");
  if (!token) return;
  setV2AuthToken(token);
  // Z fragmentu zabieramy WYŁĄCZNIE swój klucz: jedzie w nim też `join=<grant>`
  // powłoki, a wymiecenie całego hasha kasowało go, zanim onboarding zdążył go
  // przeczytać.
  fragment.delete("access_token");
  const rest = fragment.toString();
  history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
}

/** The desktop shell trades the server name and password for a grant natively
 * and lands the webui with `#join=<grant>` (`electron/main.mjs`). Read it once
 * and take it out of the URL: it is single-use, and a credential left in the
 * hash rides along into every history entry and every copied link. Other
 * fragment keys are left alone. */
export function takeJoinGrant(): string {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const grant = fragment.get("join") ?? "";
  if (!grant) return "";
  fragment.delete("join");
  const rest = fragment.toString();
  history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  return grant;
}

export function setV2AuthToken(token: string): void {
  try {
    const value = token.trim();
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage can be disabled in private browsing */
  }
}

/** A native shell's WebView cannot keep the `mb_v2_session` cookie, so the
 * server hands it the session token in the body instead (`x-multibot-client:
 * native`) and it lives here. Without it a native client that loses its
 * 15-minute access token has nothing left to refresh with — which is exactly
 * the silent logout 0.4.0 exists to end. */
export function setSessionToken(token: string): void {
  try {
    const value = token.trim();
    if (value) localStorage.setItem(SESSION_KEY, value);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage can be disabled in private browsing */
  }
}

function storedSessionToken(): string {
  try {
    return localStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

export function authEventName(): string {
  return AUTH_REQUIRED;
}

/**
 * Access tokens live 15 minutes, sessions live forever, so an expired token is
 * not a logout: the session cookie (or the native session token) mints a new
 * one. Deduplicated, because a screenful of panels hits 401 in the same second
 * and one refresh serves them all.
 */
type RefreshResult = "ok" | "rejected" | "offline";

let refreshing: Promise<RefreshResult> | null = null;

export function refreshAccessToken(): Promise<RefreshResult> {
  return (refreshing ??= requestAccessToken().finally(() => {
    refreshing = null;
  }));
}

async function requestAccessToken(): Promise<RefreshResult> {
  try {
    // Bez `Authorization`: ważny token dostępu wystawiłby sam sobie następcę i
    // 15-minutowy limit przestałby cokolwiek znaczyć. Odnawia wyłącznie sesja
    // (ciasteczko albo token sesji natywnej powłoki).
    const headers = new Headers({ "x-multibot-protocol": "2" });
    const session = storedSessionToken();
    if (session) headers.set("x-multibot-session", session);
    const response = await fetch(REFRESH_PATH, { method: "POST", headers, credentials: "same-origin" });
    if (!response.ok) return response.status === 401 || response.status === 403 ? "rejected" : "offline";
    const body = (await response.json().catch(() => ({}))) as { accessToken?: string };
    if (!body.accessToken) return "offline";
    setV2AuthToken(body.accessToken);
    return "ok";
  } catch {
    // Restart serwera, zerwana sieć — to nie jest problem z poświadczeniami,
    // więc sesja zostaje, a wołający dostaje swoje 401. Wylogowuje wyłącznie
    // odmowa sesji, nigdy awaria transportu.
    return "offline";
  }
}

function requireAuth(): void {
  window.dispatchEvent(new Event(AUTH_REQUIRED));
}

function isRefreshRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.includes(REFRESH_PATH);
}

function sendAuthed(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-multibot-protocol", "2");
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  const token = getAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const response = await sendAuthed(input, init);
  if (response.status !== 401) return response;
  // A 401 on the refresh route itself is the real thing — nothing left to try.
  if (isRefreshRequest(input)) {
    requireAuth();
    return response;
  }
  const refreshed = await refreshAccessToken();
  if (refreshed !== "ok") {
    if (refreshed === "rejected") requireAuth();
    return response;
  }
  // A stream body is consumed by the first attempt, so a replay would send an
  // empty request. The caller gets the 401 but stays signed in.
  if (init.body instanceof ReadableStream) return response;
  return sendAuthed(input, init);
}

type EventChannel = {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  close: () => void;
};

/**
 * Kanał zdarzeń aplikacji. WebSocket jest transportem pierwszego wyboru, bo
 * pośrednicy potrafią buforować odpowiedź SSE do końca strumienia — szybki
 * tunel Cloudflare robi dokładnie to i `/api/events` po SSE nie dowozi wtedy
 * ani jednej ramki (dymek wysłanej wiadomości zostaje szary, bo `message`
 * nigdy nie przychodzi). Gdy WS nie wstanie ani razu — zwykle blokada po
 * drodze albo brak WebSocketa w środowisku — schodzimy na SSE i działamy jak
 * dotąd.
 */
export function authenticatedEventSource(path: string): EventChannel {
  const source: EventChannel = {
    onopen: null,
    onerror: null,
    onmessage: null,
    close: () => {},
  };
  if (typeof WebSocket === "undefined" || typeof location === "undefined") {
    return sseEventSource(path, source);
  }

  let stopped = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sse: EventChannel | undefined;
  let retry = 0;

  const fallback = () => {
    sse = sseEventSource(path, source);
  };

  const open = () => {
    if (stopped) return;
    let opened = false;
    try {
      socket = authenticatedWebSocket(path);
    } catch {
      // brak `location`/WebSocketa (np. test w node) — zostaje SSE
      return fallback();
    }
    socket.onopen = () => {
      opened = true;
      retry = 0;
      source.onopen?.();
    };
    socket.onmessage = (event) => {
      source.onmessage?.(new MessageEvent("message", { data: String(event.data) }));
    };
    socket.onclose = () => {
      if (stopped) return;
      source.onerror?.();
      // Nigdy nie zdążył się otworzyć przy pierwszym podejściu — ten transport
      // tu nie przechodzi, więc nie zapętlamy się na nim.
      if (!opened && retry === 0) return fallback();
      retry = Math.min(retry + 1, 5);
      timer = setTimeout(open, retry * 1000);
    };
    socket.onerror = () => {
      /* onclose i tak przyjdzie — tam jest cała obsługa */
    };
  };

  source.close = () => {
    stopped = true;
    clearTimeout(timer);
    sse?.close();
    socket?.close();
  };
  open();
  return source;
}

function sseEventSource(path: string, source: EventChannel): EventChannel {
  let stopped = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pendingWait: ReturnType<typeof setTimeout> | undefined;
  let retry = 0;
  source.close = () => {
    stopped = true;
    clearTimeout(pendingWait);
    void reader?.cancel();
  };
  const wait = () => new Promise<void>((resolve) => {
    pendingWait = setTimeout(resolve, retry * 1000);
  });
  // Ile 401 z rzędu. Pierwsze `authFetch` już odświeżyło token i powtórzyło
  // żądanie, więc tu wystarczy dać strumieniowi drugie podejście; dopiero
  // 401 z rzędu oznacza koniec sesji. Drugiego odświeżenia stąd NIE wołamy:
  // gdyby tamto padło, `AUTH_REQUIRED` już poszło i token jest skasowany.
  let unauthorized = 0;
  void (async () => {
    while (!stopped) {
      let delivered = false;
      try {
        const response = await authFetch(path, { headers: { accept: "text/event-stream" } });
        if (response.status === 401) {
          if (++unauthorized > 1) {
            source.onerror?.();
            return;
          }
          if (stopped) return;
          await wait();
          continue;
        }
        unauthorized = 0;
        if (!response.ok || !response.body) {
          source.onerror?.();
          retry = Math.min(retry + 1, 5);
          if (stopped) return;
          await wait();
          continue;
        }
        source.onopen?.();
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            const data = event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) {
              delivered = true;
              source.onmessage?.(new MessageEvent("message", { data }));
            }
          }
        }
        if (stopped) return;
        source.onerror?.();
        // Zerujemy backoff dopiero po strumieniu, który realnie coś dostarczył.
        // Serwer, który łączy i natychmiast zrywa, musi wspinać się po odstępach.
        retry = delivered ? 0 : Math.min(retry + 1, 5);
        if (stopped) return;
        await wait();
      } catch {
        // Błąd sieci (np. serwer w trakcie restartu) — ponawiamy, nie giniemy.
        source.onerror?.();
        if (stopped) return;
        retry = Math.min(retry + 1, 5);
        if (stopped) return;
        await wait();
      }
    }
  })();
  return source;
}

export function authenticatedWebSocket(path: string, protocol = location.protocol): WebSocket {
  const token = getAuthToken();
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${wsProtocol}//${location.host}${path}`, token ? ["multibot-v2", token] : undefined);
}

