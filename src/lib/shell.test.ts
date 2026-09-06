import { describe, expect, it, vi } from "vitest";
import { deviceId, randomId, hasCustomWindowControls, isShellMessage, joinLocalHarness, registerPushViaShell, resolveHost, shellPost } from "./shell";

describe("hasCustomWindowControls", () => {
  it("wykrywa mostek wystawiony przez preload okna bezramkowego", () => {
    expect(hasCustomWindowControls({ ogb: { window: { close: () => {} } } })).toBe(true);
  });

  it("milczy w przeglądarce (brak ogb) i pod macOS (ogb bez window)", () => {
    expect(hasCustomWindowControls({})).toBe(false);
    expect(hasCustomWindowControls({ ogb: {} })).toBe(false);
    expect(hasCustomWindowControls(undefined)).toBe(false);
  });

  it("nie daje się nabrać na pole obecne, ale niewywoływalne", () => {
    expect(hasCustomWindowControls({ ogb: { window: {} } })).toBe(false);
    expect(hasCustomWindowControls({ ogb: { window: { close: true } } })).toBe(false);
  });
});

// Ścieżka „postaw serwer" dotyczy serwera na TYM urządzeniu. W trybie zdalnym
// desktopu strona przychodzi z lokalnego proxy dla CUDZEGO serwera, więc
// same-origin wysłałoby hasło tego urządzenia właśnie tam.
describe("joinLocalHarness", () => {
  it("w trybie zdalnym nie wysyła hasła NIGDZIE", async () => {
    let asked = false;
    const host = { __MULTIBOT_REMOTE__: true as const, ogb: { setupJoin: async () => { asked = true; return { ok: true, joinGrant: "g" }; } } };
    expect(await joinLocalHarness("brave-otter", "7f3k", host)).toEqual({ ok: false, error: "forbidden" });
    expect(asked).toBe(false);
  });

  it("w powłoce idzie przez proces główny, który zna port swojego harnessu", async () => {
    const seen: string[][] = [];
    const host = { ogb: { setupJoin: async (name: string, password: string) => { seen.push([name, password]); return { ok: true, joinGrant: "g1" }; } } };
    expect(await joinLocalHarness("brave-otter", "7f3k", host)).toEqual({ ok: true, grant: "g1" });
    expect(seen).toEqual([["brave-otter", "7f3k"]]);
  });

  it("odmowa procesu głównego przechodzi kodem, nie wyjątkiem", async () => {
    const host = { ogb: { setupJoin: async () => ({ ok: false, error: "forbidden" }) } };
    expect(await joinLocalHarness("brave-otter", "7f3k", host)).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("resolveHost w powłoce desktopowej", () => {
  it("sukces oddaje sam fakt przejęcia — grant jedzie fragmentem URL-a, nie tędy", async () => {
    const host = { ogb: { joinHost: async () => ({ ok: true, hasUsers: true }) } };
    expect(await resolveHost("https://10.0.0.5:8799", "brave-otter", "7f3k", host)).toEqual({ ok: true, hasUsers: true, handedOff: true });
  });

  it("kod błędu z powłoki przechodzi nietknięty — formularz wskazuje po nim pole", async () => {
    const host = { ogb: { joinHost: async () => ({ ok: false, error: "wrong_server_password" }) } };
    expect(await resolveHost("https://10.0.0.5:8799", "brave-otter", "zle", host)).toEqual({ ok: false, error: "wrong_server_password" });
  });

  // Droga awaryjna: lokalny origin nie wstał, więc ekran przyszedł PROSTO z
  // hosta. `hosts:join` przyjmuje tylko wołania ze swojego originu i odpowiada
  // `forbidden` — a ta strona jest już w originie serwera, więc join idzie
  // zwykłym fetchem. Bez tego zejścia ekran logowania nie miał jak wejść.
  it("`forbidden` z powłoki schodzi na join w tym samym originie", async () => {
    const wyslane: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      wyslane.push(url);
      return { ok: true, status: 200, json: async () => ({ joinGrant: "g-same-origin", hasUsers: false }) };
    });
    const host = { ogb: { joinHost: async () => ({ ok: false, error: "forbidden" }) } };
    expect(await resolveHost("https://10.0.0.5:8799", "brave-otter", "7f3k", host)).toEqual({
      ok: true,
      grant: "g-same-origin",
      hasUsers: false,
    });
    expect(wyslane).toEqual(["/api/auth/join"]);
    vi.unstubAllGlobals();
  });
});

/** Stub okna powłoki mobilnej: most `ReactNativeWebView` plus kanał zwrotny,
 * którym RN wstrzykuje odpowiedź (zdarzenie `message` bez `source` i bez
 * `origin` — jest dispatchowane w tym dokumencie, nie postowane z innego okna). */
function mobileShell(reply?: unknown, options: { origin?: string; source?: unknown } = {}) {
  const listeners: Array<(event: Event) => void> = [];
  const sent: string[] = [];
  const host = {
    location: { origin: "https://server.example" },
    addEventListener: (_type: string, listener: (event: Event) => void) => { listeners.push(listener); },
    removeEventListener: (_type: string, listener: (event: Event) => void) => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    ReactNativeWebView: {
      postMessage: (message: string) => {
        sent.push(message);
        if (reply === undefined) return;
        const event = { data: JSON.stringify(reply), origin: options.origin ?? "", source: options.source ?? null } as unknown as Event;
        for (const listener of [...listeners]) listener(event);
      },
    },
  };
  return { host, sent, listeners };
}

describe("registerPushViaShell", () => {
  it("pyta powłokę o token i zgłasza go serwerowi pod stałym id urządzenia", async () => {
    const { host, sent } = mobileShell({ type: "push.token", token: "ExponentPushToken[abc]", platform: "android", deviceName: "Pixel 8" });
    const posted: Array<[string, Record<string, unknown>]> = [];
    const outcome = await registerPushViaShell(host, async (id, body) => { posted.push([id, body]); return true; }, "dev-1");
    expect(outcome).toBe("registered");
    expect(JSON.parse(sent[0])).toEqual({ type: "push.request" });
    expect(posted).toEqual([["dev-1", { token: "ExponentPushToken[abc]", platform: "android", deviceName: "Pixel 8" }]]);
  });

  it("odmowa zgody (token null) nie jest błędem i nic nie wysyła", async () => {
    const { host } = mobileShell({ type: "push.token", token: null });
    let posted = false;
    expect(await registerPushViaShell(host, async () => { posted = true; return true; }, "dev-1")).toBe("declined");
    expect(posted).toBe(false);
  });

  it("odrzucenie przez serwer to `failed` — kolejny start spróbuje jeszcze raz", async () => {
    const { host } = mobileShell({ type: "push.token", token: "ExponentPushToken[abc]" });
    expect(await registerPushViaShell(host, async () => false, "dev-1")).toBe("failed");
  });

  it("nie odzywa się poza powłoką mobilną ani bez stałego id", async () => {
    expect(await registerPushViaShell({}, async () => true, "dev-1")).toBe("skipped");
    const { host } = mobileShell({ type: "push.token", token: "t" });
    expect(await registerPushViaShell(host, async () => true, "")).toBe("skipped");
  });

  it("sprząta po sobie nasłuch, także gdy odpowiedź przyszła", async () => {
    const { host, listeners } = mobileShell({ type: "push.token", token: "t" });
    await registerPushViaShell(host, async () => true, "dev-1");
    expect(listeners).toHaveLength(0);
  });
});

describe("deviceId", () => {
  it("jedno id na instalację — druga rejestracja podmienia ten sam wpis", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    const first = deviceId(storage);
    expect(first).toBeTruthy();
    expect(deviceId(storage)).toBe(first);
  });

  // `crypto.randomUUID` istnieje tylko w bezpiecznym kontekscie, a serwer bywa
  // ogladany po http://192.168.… — tam samo wywolanie wywalalo nas w „brak push”.
  it("poza bezpiecznym kontekstem robi id z getRandomValues, zamiast go nie mieć", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const id = deviceId(storage);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(deviceId(storage)).toBe(id);
      // ten sam pomocnik daje id załącznika w kompozytorze
      expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
  });

  it("bez pamięci woli nie mieć id niż mieć nowe co uruchomienie", () => {
    // Zmienne id zostawiałoby na serwerze martwy wpis po każdym starcie.
    expect(deviceId(undefined)).toBe("");
  });
});

// Odpowiedź powłoki mobilnej jest DISPATCHOWANA w tym dokumencie, więc nie ma
// ani `source`, ani `origin`. Osadzona ramka postująca do nas ma oba — i po tym
// ją poznajemy.
describe("isShellMessage", () => {
  const host = { location: { origin: "https://server.example" } };

  it("przepuszcza wstrzyknięcie RN i wiadomość z naszego własnego okna", () => {
    expect(isShellMessage({ source: null, origin: "" } as MessageEvent, host)).toBe(true);
    expect(isShellMessage({ source: host, origin: "https://server.example" } as unknown as MessageEvent, host)).toBe(true);
  });

  it("odrzuca inne okno i obcy origin", () => {
    expect(isShellMessage({ source: { other: true }, origin: "" } as unknown as MessageEvent, host)).toBe(false);
    expect(isShellMessage({ source: null, origin: "https://evil.example" } as MessageEvent, host)).toBe(false);
  });
});

// Powłoka mobilna wstrzykuje nonce przy ładowaniu strony i reaguje tylko na
// wiadomości, które go wiozą — inaczej cokolwiek, co znalazło się w WebView,
// mogłoby kazać jej dołączyć do cudzego serwera albo oddać token push.
describe("shellPost", () => {
  const withBridge = (nonce?: string) => {
    const sent: string[] = [];
    const host = { __MB_BRIDGE_NONCE__: nonce, ReactNativeWebView: { postMessage: (message: string) => { sent.push(message); } } };
    return { host, sent };
  };

  it("dokleja nonce do każdej wiadomości", () => {
    const { host, sent } = withBridge("n-1");
    expect(shellPost({ type: "host.join", url: "https://x" }, host)).toBe(true);
    expect(JSON.parse(sent[0])).toEqual({ type: "host.join", url: "https://x", nonce: "n-1" });
  });

  it("bez nonce (starsza powłoka) wysyła samą wiadomość, nie pole `undefined`", () => {
    const { host, sent } = withBridge();
    shellPost({ type: "push.request" }, host);
    expect(JSON.parse(sent[0])).toEqual({ type: "push.request" });
  });

  it("poza powłoką mobilną nie ma dokąd wysłać", () => {
    expect(shellPost({ type: "push.request" }, {})).toBe(false);
  });

  it("każda wiadomość mostu idzie tą drogą — join i push też", async () => {
    const { host, sent } = withBridge("n-2");
    void resolveHost("https://10.0.0.5:8799", "brave-otter", "7f3k", { ...host, location: { origin: "https://server.example" } });
    void registerPushViaShell({ ...host, location: { origin: "https://server.example" } }, async () => true, "dev-1");
    await Promise.resolve();
    expect(sent.map((message) => JSON.parse(message).nonce)).toEqual(["n-2", "n-2"]);
  });
});
