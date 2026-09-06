import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authFetch, authEventName, authenticatedEventSource } from "./auth";

describe("authenticatedEventSource", () => {
  it("ponawia po nieudanej próbie i dostarcza wiadomość, gdy serwer wraca", async () => {
    const realFetch = global.fetch;
    const calls: number[] = [];
    let attempt = 0;
    global.fetch = (async () => {
      calls.push(++attempt);
      if (attempt === 1) {
        // chwilowy błąd serwera (np. 503 w trakcie restartu)
        return new Response(null, { status: 503, statusText: "Service Unavailable" });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const received: string[] = [];
    const es = authenticatedEventSource("/api/events");
    const done = new Promise<void>((resolve) => {
      es.onmessage = (ev) => {
        received.push(ev.data);
        resolve();
      };
    });

    try {
      await done;
      // pierwsza próba padła (503) — klient musiał wykonać drugie zapytanie,
      // zanim dotarła wiadomość
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(received[0]).toBe("hello");
    } finally {
      es.close();
      global.fetch = realFetch;
    }
  });
});

describe("authFetch: 401 odświeża token zamiast wylogowywać", () => {
  const realFetch = global.fetch;
  const realWindow = (globalThis as { window?: unknown }).window;
  const realStorage = (globalThis as { localStorage?: unknown }).localStorage;
  let calls: { url: string; authorization: string | null; session: string | null }[] = [];
  let authRequired = 0;

  const storage = new Map<string, string>();
  const stubFetch = (reply: (url: string, call: number) => Response) => {
    let call = 0;
    global.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      calls.push({ url, authorization: headers.get("authorization"), session: headers.get("x-multibot-session") });
      return Promise.resolve(reply(url, ++call));
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    calls = [];
    authRequired = 0;
    storage.clear();
    storage.set("multibot.auth.token", "stale");
    (globalThis as { window?: unknown }).window = {
      dispatchEvent: (event: Event) => {
        if (event.type === authEventName()) authRequired += 1;
        return true;
      },
    };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    };
  });

  afterEach(() => {
    global.fetch = realFetch;
    (globalThis as { window?: unknown }).window = realWindow;
    (globalThis as { localStorage?: unknown }).localStorage = realStorage;
  });

  const fresh = () => new Response(JSON.stringify({ accessToken: "fresh" }), { status: 200 });

  it("po udanym odświeżeniu powtarza żądanie raz, bez zdarzenia wylogowania", async () => {
    stubFetch((url) => {
      if (url.includes("/api/auth/access-token")) return fresh();
      return calls.filter((c) => c.url === "/api/instances").length > 1
        ? new Response("{}", { status: 200 })
        : new Response(null, { status: 401 });
    });

    const response = await authFetch("/api/instances");

    expect(response.status).toBe(200);
    expect(authRequired).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["/api/instances", "/api/auth/access-token", "/api/instances"]);
    // powtórka musi jechać ŚWIEŻYM tokenem, inaczej dostanie to samo 401
    expect(calls[0].authorization).toBe("Bearer stale");
    expect(calls[2].authorization).toBe("Bearer fresh");
    expect(storage.get("multibot.auth.token")).toBe("fresh");
    // odświeżenie jedzie na samej sesji: ważny token wystawiałby sobie
    // następcę w nieskończoność i 15 minut przestałoby cokolwiek znaczyć
    expect(calls[1].authorization).toBeNull();
    expect(calls[1].session).toBeNull();
  });

  it("dopiero nieudane odświeżenie wywołuje dokładnie jedno wylogowanie", async () => {
    stubFetch(() => new Response(null, { status: 401 }));

    const response = await authFetch("/api/instances");

    expect(response.status).toBe(401);
    expect(authRequired).toBe(1);
    expect(calls.map((c) => c.url)).toEqual(["/api/instances", "/api/auth/access-token"]);
  });

  it("trzy równoległe 401 dają jedno odświeżenie", async () => {
    const done = new Set<string>();
    stubFetch((url) => {
      if (url.includes("/api/auth/access-token")) return fresh();
      if (done.has(url)) return new Response("{}", { status: 200 });
      done.add(url);
      return new Response(null, { status: 401 });
    });

    await Promise.all([authFetch("/api/bots"), authFetch("/api/instances"), authFetch("/api/rooms")]);

    expect(calls.filter((c) => c.url.includes("/api/auth/access-token"))).toHaveLength(1);
    expect(authRequired).toBe(0);
  });

  it("nie wylogowuje, gdy odświeżenie padnie na transporcie", async () => {
    stubFetch((url) => new Response(null, { status: url.includes("/api/auth/access-token") ? 503 : 401 }));

    const response = await authFetch("/api/instances");

    expect(response.status).toBe(401);
    // restart serwera to nie odmowa poświadczeń — sesja zostaje
    expect(authRequired).toBe(0);
    expect(storage.get("multibot.auth.token")).toBe("stale");
  });

  it("natywna powłoka odświeża tokenem sesji, nie ciasteczkiem", async () => {
    storage.set("multibot.auth.session", "native-session");
    stubFetch((url) => (url.includes("/api/auth/access-token") ? fresh() : new Response("{}", { status: 200 })));

    await authFetch("/api/instances");
    expect(calls.some((c) => c.url.includes("/api/auth/access-token"))).toBe(false);

    stubFetch((url) => {
      if (url.includes("/api/auth/access-token")) return fresh();
      return calls.filter((c) => c.url === "/api/rooms").length > 1
        ? new Response("{}", { status: 200 })
        : new Response(null, { status: 401 });
    });
    await authFetch("/api/rooms");

    expect(calls.find((c) => c.url.includes("/api/auth/access-token"))?.session).toBe("native-session");
  });
});
