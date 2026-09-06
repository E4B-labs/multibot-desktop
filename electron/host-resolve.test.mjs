// Testy host-resolve.mjs. Pod vitest (`pnpm test`) — wcześniej leżały pod
// node:test i nie uruchamiał ich nikt (docs/engineering/REPO_STATE.md §6).
import { describe, expect, it } from "vitest";

import {
  activeIdAfterMerge,
  isOnionHost,
  mergeRemoteHost,
  normalizeRemoteUrl,
  removeRemoteHost,
  resolveActiveTarget,
  sameDocument,
  sameOrigin,
  shouldStartLocalHarness,
  uiOriginChanged,
} from "./host-resolve.mjs";

describe("host resolve", () => {
  it("normalizeRemoteUrl strips trailing slashes and validates scheme", () => {
    expect(normalizeRemoteUrl("https://host.ts.net/")).toBe("https://host.ts.net");
    expect(normalizeRemoteUrl(" http://127.0.0.1:8799// ")).toBe("http://127.0.0.1:8799");
    expect(() => normalizeRemoteUrl("not-a-url")).toThrow();
    expect(() => normalizeRemoteUrl("")).toThrow();
  });

  it("normalizeRemoteUrl fills https:// in for a bare address:port, but only when asked", () => {
    // Tak wygląda adres z trzech wartości serwera przepisany z drugiego
    // urządzenia. Serwer 0.4.0 słucha wyłącznie po HTTPS, więc w drodze
    // logowania schemat jest rozstrzygnięty, a nie zgadywany.
    const https = { assumeHttps: true };
    expect(normalizeRemoteUrl("192.168.1.42:8799", https)).toBe("https://192.168.1.42:8799");
    expect(normalizeRemoteUrl(" [2a00:f41:8c4:1::7]:8799/ ", https)).toBe("https://[2a00:f41:8c4:1::7]:8799");
    expect(normalizeRemoteUrl("brave-otter.local:8799", https)).toBe("https://brave-otter.local:8799");
    expect(normalizeRemoteUrl("[::ffff:192.168.1.1]:8799", https)).toBe("https://[::ffff:192.168.1.1]:8799");
    // Domyślnie NIE zgadujemy: stara droga („Połącz" w onboardingu) dodaje dziś
    // także serwery po gołym HTTP i zapisałaby wtedy martwy adres.
    expect(() => normalizeRemoteUrl("192.168.1.42:8799")).toThrow();
    // Bez portu to już zgadywanie — zostaje błąd, tak samo jak port spoza zakresu.
    expect(() => normalizeRemoteUrl("192.168.1.42", https)).toThrow();
    expect(() => normalizeRemoteUrl("192.168.1.42:99999", https)).toThrow();
    expect(() => normalizeRemoteUrl("192.168.1.42:0", https)).toThrow();
  });

  it("normalizeRemoteUrl odrzuca adres z wbudowanym loginem", () => {
    // Poświadczenia z URL-a jechałyby potem w każdym żądaniu i zostały w
    // zapisanym rekordzie hosta.
    expect(() => normalizeRemoteUrl("https://kacper:sekret@h:8799")).toThrow(/username or password/);
    expect(() => normalizeRemoteUrl("kacper:sekret@h:8799", { assumeHttps: true })).toThrow(/username or password/);
  });

  it("mergeRemoteHost keeps one record per server and inherits what the new one lacks", () => {
    const stary = { id: "a", name: "Stary", url: "https://h:8799", tokenEnc: "tok", tlsFingerprint: "AA:BB", createdAt: 1 };
    const duplikat = { id: "b", name: "Duplikat", url: "https://h:8799/", createdAt: 2 };
    const nowy = { id: "c", name: "", url: "https://h:8799", tokenEnc: undefined, tlsFingerprint: undefined, createdAt: 9 };
    // Oba wpisy o tym samym originie znikają, zostaje jeden — z id, tokenem i
    // odciskiem pierwszego, bo nowy ich nie przyniósł.
    expect(mergeRemoteHost([stary, duplikat], nowy)).toEqual([
      { id: "a", name: "Stary", url: "https://h:8799", tokenEnc: "tok", tlsFingerprint: "AA:BB", createdAt: 1 },
    ]);
    // Obcy host zostaje nietknięty i ląduje za nowym.
    const obcy = { id: "z", url: "https://inny:8799" };
    expect(mergeRemoteHost([obcy], nowy).map((h) => h.id)).toEqual(["c", "z"]);
  });

  it("removeRemoteHost drops only the matching id", () => {
    expect(removeRemoteHost([{ id: "a" }, { id: "b" }], "a")).toEqual([{ id: "b" }]);
  });

  it("resolveActiveTarget: missing config, activeId=local, or dangling id => local", () => {
    expect(resolveActiveTarget(null)).toEqual({ mode: "local" });
    expect(resolveActiveTarget({ activeId: "local", hosts: [] })).toEqual({ mode: "local" });
    expect(resolveActiveTarget({ activeId: "missing", hosts: [] })).toEqual({ mode: "local" });
  });

  it("resolveActiveTarget: known remote id => that host", () => {
    const host = { id: "h1", url: "https://h1" };
    expect(resolveActiveTarget({ activeId: "h1", hosts: [host] })).toEqual({ mode: "remote", host });
  });
});

describe("local harness startup decision", () => {
  // Sedno poprawki: z aktywnym hostem zdalnym zapakowana apka nie forkuje
  // lokalnego serwera — inaczej zakłada ~/.openmausbot i pokazuje ekran
  // zakładania serwera, którego użytkownik nigdy nie chciał.
  it("never starts the harness while a remote host is active", () => {
    expect(shouldStartLocalHarness({ isPackaged: true, mode: "remote" })).toBe(false);
  });

  it("still starts the harness for the packaged local target", () => {
    expect(shouldStartLocalHarness({ isPackaged: true, mode: "local" })).toBe(true);
  });

  it("never starts the harness in dev, whatever the target", () => {
    expect(shouldStartLocalHarness({ isPackaged: false, mode: "local" })).toBe(false);
    expect(shouldStartLocalHarness({ isPackaged: false, mode: "remote" })).toBe(false);
  });
});

describe("re-joining a server that is already known", () => {
  // Objaw: po ponownym „Połącz" apka wracała na ekran wyboru zamiast wejść na
  // serwer. `mergeRemoteHost` zachowuje STARE id, a `hosts:join` ustawia nim
  // activeId — więc rekord trzeba wziąć z listy PO scaleniu, nie z wejścia.
  it("keeps the id that activeId has to point at", () => {
    const stary = { id: "h_stary", name: "telefon", url: "https://1.2.3.4:8799", tlsFingerprint: "AA", createdAt: 1 };
    const swiezy = { id: "h_nowy", name: "", url: "https://1.2.3.4:8799", createdAt: 2 };
    const hosts = mergeRemoteHost([stary], swiezy);
    const zapisany = hosts.find((h) => sameOrigin(h.url, swiezy.url));
    expect(zapisany.id).toBe("h_stary");
    expect(resolveActiveTarget({ activeId: zapisany.id, hosts })).toEqual({ mode: "remote", host: zapisany });
    // To był błąd: id z wejścia nie pasuje do żadnego rekordu, więc apka
    // cicho lądowała w trybie lokalnym.
    expect(resolveActiveTarget({ activeId: swiezy.id, hosts })).toEqual({ mode: "local" });
  });
});

describe("sameDocument", () => {
  // Zmiana samego fragmentu to nawigacja w obrębie dokumentu: strona się nie
  // przeładowuje, więc `#join=<grant>` nigdy nie zostaje odczytany.
  it("spots a fragment-only change", () => {
    expect(sameDocument("http://127.0.0.1:47820/", "http://127.0.0.1:47820/#join=g")).toBe(true);
    expect(sameDocument("http://127.0.0.1:47820/#join=a", "http://127.0.0.1:47820/#join=b")).toBe(true);
  });

  it("a different origin or a blank window is a real load", () => {
    expect(sameDocument("http://127.0.0.1:8799/", "http://127.0.0.1:47820/#join=g")).toBe(false);
    expect(sameDocument("", "http://127.0.0.1:47820/#join=g")).toBe(false);
  });

  // Porównujemy adres, który ZBUDOWALIŚMY z rekordu hosta, z tym, co oddaje
  // `webContents.getURL()` — a przeglądarka kanonizuje nazwę hosta i port.
  // Surowe `===` mówiło tu „inny dokument", więc skok przez `about:blank` nie
  // następował i grant w `#join=` przepadał.
  it("canonicalises host casing and the default port", () => {
    expect(sameDocument("https://host.TS.net:8799/", "https://host.ts.net:8799/#join=g")).toBe(true);
    expect(sameDocument("https://host.ts.net:443/", "https://host.ts.net/#join=g")).toBe(true);
    expect(sameDocument("about:blank", "http://127.0.0.1:47820/#join=g")).toBe(false);
  });
});

describe("activeIdAfterMerge", () => {
  // Objaw: dwa rekordy tego samego serwera, activeId na tym DRUGIM. Scalanie
  // zostawia pierwszy i kasuje drugi, więc activeId zawisa i apka cicho wraca
  // na „to urządzenie" mimo udanego logowania.
  it("repoints a dangling activeId at the record that swallowed it", () => {
    const pierwszy = { id: "h_a", url: "https://1.2.3.4:8799", createdAt: 1 };
    const drugi = { id: "h_b", url: "https://1.2.3.4:8799/", createdAt: 2 };
    const hosts = mergeRemoteHost([pierwszy, drugi], { id: "h_nowy", url: "https://1.2.3.4:8799", createdAt: 3 });
    expect(hosts).toHaveLength(1);
    expect(activeIdAfterMerge("h_b", hosts)).toBe("h_a");
    expect(resolveActiveTarget({ activeId: activeIdAfterMerge("h_b", hosts), hosts }).mode).toBe("remote");
  });

  it("leaves local and a still-live id alone — adding a host must not activate it", () => {
    const inny = { id: "h_inny", url: "https://5.6.7.8:8799", createdAt: 1 };
    const hosts = mergeRemoteHost([inny], { id: "h_nowy", url: "https://1.2.3.4:8799", createdAt: 2 });
    expect(activeIdAfterMerge("local", hosts)).toBe("local");
    expect(activeIdAfterMerge(undefined, hosts)).toBe("local");
    expect(activeIdAfterMerge("h_inny", hosts)).toBe("h_inny");
  });
});

describe("uiOriginChanged", () => {
  // Wszystkie hosty dzielą jeden origin proxy, więc token i cookie zostają po
  // poprzednim — bez tego przełączenie A→B wysyła do B poświadczenia od A.
  it("says yes for a fresh origin and for a change of host, no for the same one", () => {
    expect(uiOriginChanged({}, "https://1.2.3.4:8799")).toBe(true);
    expect(uiOriginChanged({ uiOriginHost: "https://5.6.7.8:8799" }, "https://1.2.3.4:8799")).toBe(true);
    expect(uiOriginChanged({ uiOriginHost: "https://1.2.3.4:8799" }, "https://1.2.3.4:8799")).toBe(false);
  });
});

// PLAN-TOR: adres usługi ukrytej wchodzi tą samą drogą co każdy inny — to jest
// cała zmiana po stronie rozwiązywania adresu. Gdyby `normalizeRemoteUrl` go
// odrzucało, nie byłoby czego tunelować.
describe("adres .onion", () => {
  const ONION = "a".repeat(56) + ".onion";

  it("normalizeRemoteUrl bierze .onion bez żadnego wyjątku", () => {
    expect(normalizeRemoteUrl(`https://${ONION}:8799/`)).toBe(`https://${ONION}:8799`);
    // Tak wygląda adres przepisany z trzech wartości serwera na drugim urządzeniu.
    expect(normalizeRemoteUrl(`${ONION}:8799`, { assumeHttps: true })).toBe(`https://${ONION}:8799`);
  });

  it("isOnionHost rozpoznaje goły host, host:port i cały URL", () => {
    expect(isOnionHost(ONION)).toBe(true);
    expect(isOnionHost(`${ONION}:8799`)).toBe(true);
    expect(isOnionHost(`https://${ONION}:8799/`)).toBe(true);
    expect(isOnionHost(` HTTPS://${ONION.toUpperCase()}:8799 `)).toBe(true);
  });

  it("odsiewa wszystko, czego tor nie zestawi", () => {
    // v2 (16 znaków) wyłączono w sieci Tora w 2021 — przyjęcie go byłoby
    // obietnicą połączenia, którego nie da się zbudować.
    expect(isOnionHost("a".repeat(16) + ".onion")).toBe(false);
    expect(isOnionHost("a".repeat(55) + ".onion")).toBe(false);
    // `1`, `8`, `9` i `0` są poza alfabetem base32.
    expect(isOnionHost("1".repeat(56) + ".onion")).toBe(false);
    expect(isOnionHost(`${ONION}.evil.com`)).toBe(false);
    expect(isOnionHost("https://192.168.1.42:8799")).toBe(false);
    expect(isOnionHost("https://[::1]:8799")).toBe(false);
    expect(isOnionHost("")).toBe(false);
    expect(isOnionHost(null)).toBe(false);
  });
});
