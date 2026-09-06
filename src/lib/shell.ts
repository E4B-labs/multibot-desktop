// multibot: kto rysuje ramkę okna. Na Windowsie i Linuksie aplikacja leci
// bezramkowo (electron/main.mjs → frame:false), więc minimalizację,
// maksymalizację i zamknięcie musi narysować sam interfejs. Preload wystawia
// `window.ogb.window` dokładnie tam i tylko tam, więc jedno sprawdzenie
// odsiewa naraz przeglądarkę i macOS-a. Platformy NIE zgadujemy z userAgenta:
// decyzja o ramce zapada w main.mjs i to ona ma być jedynym źródłem prawdy.
//
// Resztę — przeciąganie okna za nagłówki i pas zarezerwowany pod kontrolkami —
// robi CSS na klasie `multibot-frameless` i atrybucie `data-shell-header`
// (src/styles.css). Dzięki temu żaden panel nie musi wiedzieć, czy akurat stoi
// przy prawej krawędzi okna.
import type { CSSProperties } from "react";
import { authFetch } from "./auth";

type WindowControlsHost = { ogb?: { window?: { close?: unknown } } };

export function hasCustomWindowControls(
  host: WindowControlsHost | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  return typeof host?.ogb?.window?.close === "function";
}

/** Kontrolki okna wiszą poza nagłówkami, więc żaden obszar `drag` ich nie
 * obejmuje — ale oznaczamy je wprost, żeby zmiana układu nie zamieniła ich
 * cicho w uchwyt do przeciągania. */
export const noDragRegion = { WebkitAppRegion: "no-drag" } as CSSProperties;

// ── 0.4.0 onboarding: the two things only the shell around the page knows ──
// The webui lives in the server's origin, so a sign-in for a DIFFERENT address
// cannot be a plain fetch (no CORS, and the credentials would have to travel
// before we know the address is even ours). Electron and the mobile shell trade
// name+password for a short-lived grant natively and reload the page in the
// server's origin with `#join=<grant>`; a browser is already there, so it just
// posts to its own origin.

type ReactNativeBridge = { postMessage(message: string): void };
type Listeners = {
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
};
export type ShellHost = Listeners & {
  __MULTIBOT_REMOTE__?: true;
  __MB_BRIDGE_NONCE__?: string;
  ReactNativeWebView?: ReactNativeBridge;
  ogb?: {
    joinHost?(url: string, serverName: string, serverPassword: string): Promise<{ ok: boolean; hasUsers?: boolean; error?: string }>;
    setupJoin?(serverName: string, serverPassword: string): Promise<{ ok: boolean; joinGrant?: string; error?: string }>;
  };
  document?: Listeners;
  location?: { origin?: string };
};

function currentHost(): ShellHost | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as ShellHost);
}

/** Every message to the mobile shell goes through here so it carries the nonce
 * the shell injected into this page. The shell acts only on messages that carry
 * it, which is what stops anything that got into the WebView some other way —
 * a stray script, a page the WebView was navigated to — from driving the bridge
 * and asking it to join a server or hand over a push token.
 *
 * The field is simply absent outside the mobile shell, and in shells older than
 * the nonce; those ignore it. Returns false when there is no bridge at all.
 */
export function shellPost(message: Record<string, unknown>, host: ShellHost | undefined = currentHost()): boolean {
  const bridge = host?.ReactNativeWebView;
  if (!bridge) return false;
  const nonce = host?.__MB_BRIDGE_NONCE__;
  bridge.postMessage(JSON.stringify(nonce ? { ...message, nonce } : message));
  return true;
}

/** Only the mobile shell needs the message channel and the session token: an
 * Electron WebContents keeps the `mb_v2_session` cookie like any browser. */
export function isReactNativeShell(host: ShellHost | undefined = currentHost()): boolean {
  return typeof host?.ReactNativeWebView?.postMessage === "function";
}

/** `handedOff` means the shell is reloading this page with the grant in the
 * fragment — nothing more to do here, and no grant comes back to the renderer
 * (a credential handed to the page is a credential in the console log). */
export type HostJoinOutcome =
  | { ok: true; grant?: string; hasUsers?: boolean; handedOff?: boolean }
  | { ok: false; error: string };

/** Join the server this page is served by. Used by the setup path (the server
 * is right here) and by a browser sign-in, where the address is `location.origin`
 * and readonly for the same reason. */
export async function joinSameOrigin(serverName: string, serverPassword: string): Promise<HostJoinOutcome> {
  try {
    const response = await fetch("/api/auth/join", {
      method: "POST",
      headers: { "content-type": "application/json", "x-multibot-protocol": "2" },
      credentials: "same-origin",
      body: JSON.stringify({ serverName, serverPassword }),
    });
    const body = (await response.json().catch(() => ({}))) as { joinGrant?: string; hasUsers?: boolean; error?: string };
    if (response.status === 429) return { ok: false, error: "rate_limited" };
    if (!response.ok || !body.joinGrant) return { ok: false, error: body.error ?? "unreachable" };
    return { ok: true, grant: body.joinGrant, hasUsers: body.hasUsers };
  } catch {
    // The server we are served by stopped answering — that is the address being
    // unreachable, not a wrong password.
    return { ok: false, error: "unreachable" };
  }
}

/** The mobile shell answers `host.join` with this, so the form can stop
 * spinning and say what went wrong. Both messages are JSON strings:
 *
 *   webui → shell   {"type":"host.join","url","serverName","serverPassword"}
 *   shell → webui   {"type":"host.join.result","ok":true}
 *                   {"type":"host.join.result","ok":false,"error":"unreachable"}
 *
 * `ok:true` means the shell is reloading the WebView on that host with
 * `#join=<grant>`; the grant never comes back through this channel. Error codes
 * are the ones in src/types/ogb.d.ts. React Native delivers injected messages
 * on `window` (iOS) or `document` (Android), so both are listened to. */
const SHELL_REPLY_TIMEOUT_MS = 20_000;

/** React Native delivers an injected message as a `message` event with no
 * `source` and an empty `origin` — it is dispatched into this document, not
 * posted from another window. So: accept "came from nowhere" and "came from
 * us", reject anything that names a different window or origin, which is what a
 * cross-origin `postMessage` from an embedding frame looks like.
 *
 * Which target fires it differs by platform (iOS `window`, Android
 * `document`), so both are listened to and the first answer wins. */
export function isShellMessage(event: Pick<MessageEvent, "source" | "origin">, host: ShellHost): boolean {
  const origin = host.location?.origin;
  if (event.source && event.source !== (host as unknown as MessageEventSource)) return false;
  return !event.origin || !origin || event.origin === origin;
}

/** Wait for one `{type}` reply from the shell. `null` on timeout: a shell too
 * old to answer must not leave a button spinning forever. */
function awaitShellMessage<T>(type: string, host: ShellHost, timeoutMs = SHELL_REPLY_TIMEOUT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    const targets = [host, host.document].filter((target): target is Listeners => Boolean(target?.addEventListener));
    const finish = (value: T | null) => {
      clearTimeout(budget);
      for (const target of targets) target.removeEventListener?.("message", listen);
      resolve(value);
    };
    const listen = (event: Event) => {
      const message = event as MessageEvent;
      if (!isShellMessage(message, host) || typeof message.data !== "string") return;
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (parsed?.type !== type) return;
      finish(parsed as T);
    };
    const budget = setTimeout(() => finish(null), timeoutMs);
    for (const target of targets) target.addEventListener?.("message", listen);
  });
}

async function awaitNativeJoin(host: ShellHost): Promise<HostJoinOutcome> {
  const reply = await awaitShellMessage<{ ok?: boolean; error?: string }>("host.join.result", host);
  if (!reply) return { ok: false, error: "timeout" };
  return reply.ok ? { ok: true, handedOff: true } : { ok: false, error: reply.error || "unreachable" };
}

/** Joining the harness on THIS device, for the setup path. Never
 * `location.origin`: in the desktop shell's remote mode the page is served by a
 * loopback proxy for somebody else's server, so same-origin would send this
 * device's server password to that server. The main process knows which port
 * its own harness is on and refuses when the active host is not local. */
export async function joinLocalHarness(
  serverName: string,
  serverPassword: string,
  host: ShellHost | undefined = currentHost(),
): Promise<HostJoinOutcome> {
  if (host?.__MULTIBOT_REMOTE__) return { ok: false, error: "forbidden" };
  const setupJoin = host?.ogb?.setupJoin;
  if (setupJoin) {
    const result = await setupJoin(serverName, serverPassword);
    return result.ok && result.joinGrant ? { ok: true, grant: result.joinGrant } : { ok: false, error: result.error ?? "unreachable" };
  }
  // A plain browser is only ever served by the server it is setting up.
  return joinSameOrigin(serverName, serverPassword);
}

export async function resolveHost(
  url: string,
  serverName: string,
  serverPassword: string,
  host: ShellHost | undefined = currentHost(),
): Promise<HostJoinOutcome> {
  const native = host?.ReactNativeWebView;
  if (native && host) {
    // Listen BEFORE asking: a shell that answers instantly must not answer into
    // a channel nobody is on yet.
    const answer = awaitNativeJoin(host);
    shellPost({ type: "host.join", url, serverName, serverPassword }, host);
    return answer;
  }
  const joinHost = host?.ogb?.joinHost;
  if (joinHost) {
    const result = await joinHost(url, serverName, serverPassword);
    if (result.ok) return { ok: true, hasUsers: result.hasUsers, handedOff: true };
    // `forbidden` znaczy jedno: ta strona przyszła PROSTO z hosta, bo lokalny
    // origin nie wstał (electron/remote-ui.mjs → main.mjs degraduje do
    // `loadURL` na adres hosta). Powłoka przyjmuje `hosts:join` tylko ze
    // swojego originu, więc tutaj nie ma innej drogi — i nie trzeba jej: strona
    // JEST w originie serwera, do którego się logujemy, więc join idzie zwykłym
    // fetchem. Bez tego ekran logowania w drodze awaryjnej nie miał jak wejść.
    if (result.error !== "forbidden") return { ok: false, error: result.error ?? "unreachable" };
  }
  return joinSameOrigin(serverName, serverPassword);
}

/** `navigator.clipboard` is gated on a secure context, and the whole point of
 * the setup screen is being read on `http://192.168.…` in a WebView. The old
 * `execCommand("copy")` still works there, so it is the fallback rather than a
 * "copying is not supported" message on the one screen that has to be copied. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* not a secure context, or permission denied — fall through */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

// ── push registration, mobile only ─────────────────────────────────────────
// The mobile shell stopped registering push by itself (multibot-mobile PR #30):
// it owns the OS permission prompt and the Expo token, the webui owns the
// session that says WHOSE device this is. So the webui asks, the shell answers,
// and the webui posts the token to the server it is signed in to.
//
//   webui → shell   {"type":"push.request"}
//   shell → webui   {"type":"push.token","token":"ExponentPushToken[…]",
//                    "platform":"android","deviceName":"Pixel 8"}
//                   {"type":"push.token","token":null}   ← permission declined
//
// Same reply channel as `host.join.result`.
const DEVICE_ID_KEY = "multibot.device.id";

/** Losowe id, które działa także poza bezpiecznym kontekstem.
 *
 * `crypto.randomUUID` istnieje TYLKO w secure context, a serwer 0.4.0 bywa
 * oglądany po `http://192.168.…` — tam jest `undefined` i samo wywołanie rzuca
 * (w `deviceId` lądowało to w „brak push", w kompozytorze wywalało dodanie
 * załącznika). `getRandomValues` jest dostępne zawsze, więc id po prostu ma
 * inny kształt: 32 znaki hex zamiast UUID-a. */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One stable id per install, so re-registering replaces this device's row
 * instead of adding another. Empty when storage is unavailable — a churning id
 * would leave a new dead row on the server every launch, which is worse than
 * no push at all. */
export function deviceId(storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): string {
  try {
    const stored = storage?.getItem(DEVICE_ID_KEY);
    if (stored) return stored;
    const fresh = randomId();
    storage?.setItem(DEVICE_ID_KEY, fresh);
    return storage ? fresh : "";
  } catch {
    return "";
  }
}

export type PushOutcome = "registered" | "declined" | "skipped" | "failed";

/** Called once per app start after sign-in. Deliberately every start rather
 * than once ever: it costs one message, it retries a registration the server
 * rejected, and it picks up an Expo token the OS rotated behind our back. */
export async function registerPushViaShell(
  host: ShellHost | undefined = currentHost(),
  send: (id: string, body: Record<string, unknown>) => Promise<boolean> = postPushToken,
  id: string = deviceId(),
): Promise<PushOutcome> {
  const native = host?.ReactNativeWebView;
  if (!native || !host) return "skipped";
  if (!id) return "skipped";
  const answer = awaitShellMessage<{ token?: string | null; platform?: string; deviceName?: string }>("push.token", host);
  shellPost({ type: "push.request" }, host);
  const reply = await answer;
  // No answer at all is an older shell, not a refusal — same outcome either way:
  // nothing to register, try again next start.
  if (!reply?.token) return "declined";
  return (await send(id, { token: reply.token, platform: reply.platform, deviceName: reply.deviceName })) ? "registered" : "failed";
}

async function postPushToken(id: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await authFetch(`/api/devices/${encodeURIComponent(id)}/push`, { method: "POST", body: JSON.stringify(body) });
    return response.ok;
  } catch {
    return false;
  }
}
