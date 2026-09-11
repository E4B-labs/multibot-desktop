import { afterEach, describe, expect, it } from "vitest";

import { openFileViaShell } from "./nativeBridge";

// Poza powłoką telefonu most MUSI odmówić synchronicznie: karta pliku i dialog
// podglądu wołają `preventDefault()` tylko na `true`, więc `false` to jedyne,
// co zostawia w przeglądarce i w Electronie zwykłe `<a download>` działające
// tak, jak działało.
describe("openFileViaShell", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("zwraca false bez mostu i nie wysyła żądania odświeżenia tokenu", () => {
    let asked = false;
    global.fetch = (async () => {
      asked = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    expect(openFileViaShell("/api/bots/b1/attachments/f1", "raport.pdf", "application/pdf", {})).toBe(false);
    expect(openFileViaShell("/api/bots/b1/attachments/f1", "raport.pdf", "application/pdf", { ReactNativeWebView: {} as never })).toBe(false);
    expect(asked).toBe(false);
  });

  it("w powłoce oddaje ścieżkę, nazwę i nagłówki, z noncem mostu", async () => {
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    const sent: string[] = [];
    const host = {
      __MB_BRIDGE_NONCE__: "n1",
      ReactNativeWebView: { postMessage: (payload: string) => sent.push(payload) },
    };
    expect(openFileViaShell("/api/bots/b1/attachments/f1", "raport.pdf", "application/pdf", host)).toBe(true);
    // wiadomość idzie po odświeżeniu tokenu, więc dopiero po mikrozadaniach
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({
      type: "file.open",
      url: "/api/bots/b1/attachments/f1",
      name: "raport.pdf",
      mime: "application/pdf",
      headers: { "x-multibot-protocol": "2" },
      nonce: "n1",
    });
  });
});
