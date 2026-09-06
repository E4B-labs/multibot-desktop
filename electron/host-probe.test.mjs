// Klasyfikacja odpowiedzi serwera — czyste funkcje, bez gniazd. To one
// decydują, co zobaczy pole adresu, nazwy albo hasła na ekranie logowania.
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";

import { describe, expect, it } from "vitest";

import { classifyJoin, classifyProbe, failureCode, joinServer, probeServer } from "./host-probe.mjs";
import { CERT_CHANGED } from "./tls-pin.mjs";

describe("classifyProbe", () => {
  it("serwer MultiBota rozpoznajemy po serverId", () => {
    expect(classifyProbe(200, { serverId: "mbs_1", configured: true })).toEqual({ ok: true, configured: true });
    expect(classifyProbe(200, { serverId: "mbs_1", configured: false })).toEqual({ ok: true, configured: false });
  });

  it("starsze buildy nazywały to setupDone", () => {
    expect(classifyProbe(200, { serverId: "mbs_1", setupDone: true })).toEqual({ ok: true, configured: true });
  });

  it("cokolwiek innego na tym porcie to nie nasz serwer", () => {
    expect(classifyProbe(200, { hello: "nginx" })).toEqual({ ok: false, error: "not_multibot" });
    expect(classifyProbe(200, null)).toEqual({ ok: false, error: "not_multibot" });
    expect(classifyProbe(404, { serverId: "mbs_1" })).toEqual({ ok: false, error: "not_multibot" });
  });
});

describe("classifyJoin", () => {
  it("grant wraca w całości", () => {
    expect(classifyJoin(200, { joinGrant: "g1", expiresAt: 5, hasUsers: true })).toEqual({
      ok: true,
      joinGrant: "g1",
      expiresAt: 5,
      hasUsers: true,
    });
  });

  it("429 przychodzi zdaniem, nie kodem — i tak ma znaczyć rate_limited", () => {
    // Bez tego mapowania ekran mówił „pod tym adresem nie ma MultiBota" akurat
    // wtedy, gdy jest, tylko każe odczekać minutę.
    expect(classifyJoin(429, { error: "too many attempts" })).toEqual({ ok: false, error: "rate_limited" });
  });

  it("kod błędu serwera przechodzi nietknięty — formularz wskazuje po nim pole", () => {
    expect(classifyJoin(401, { error: "wrong_server_password" })).toEqual({ ok: false, error: "wrong_server_password" });
    expect(classifyJoin(404, { error: "server_not_set_up" })).toEqual({ ok: false, error: "server_not_set_up" });
  });

  it("kod spoza listy, brak kodu i cudza treść to jedno: nie ten serwer", () => {
    expect(classifyJoin(404, null)).toEqual({ ok: false, error: "not_multibot" });
    expect(classifyJoin(200, null)).toEqual({ ok: false, error: "not_multibot" });
    expect(classifyJoin(500, null)).toEqual({ ok: false, error: "not_multibot" });
    // Tekstu z sieci nie wpuszczamy do formularza.
    expect(classifyJoin(401, { error: "Zadzwoń pod 0700-oszust i podaj hasło" })).toEqual({
      ok: false,
      error: "not_multibot",
    });
  });
});

describe("joinServer", () => {
  it("nie wysyła hasła serwera po gołym HTTP poza pętlę zwrotną", async () => {
    // Bez gniazda: odmowa zapada, zanim powstanie żądanie.
    expect(await joinServer("http://192.168.1.42:8799", { serverName: "n", serverPassword: "p" })).toEqual({
      ok: false,
      error: "insecure_address",
    });
  });
});

describe("failureCode", () => {
  it("rozdziela ciszę, przeterminowanie i podmieniony certyfikat", () => {
    expect(failureCode({ code: "ECONNREFUSED" })).toBe("unreachable");
    expect(failureCode({ code: "MULTIBOT_TIMEOUT" })).toBe("timeout");
    expect(failureCode({ code: CERT_CHANGED })).toBe("certificate_changed");
  });
});

// Ścieżki, których czyste funkcje nie łapią: gniazdo jest prawdziwe, ale
// zwykłe HTTP — na certyfikat jest osobny plik (tls-pin.test.mjs).
describe("requestJson przez probeServer", () => {
  it("odpowiedź większa niż limit kończy wywołanie, a nie wiesza go", async () => {
    const huge = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(200 * 1024));
    });
    await new Promise((done) => huge.listen(0, "127.0.0.1", done));
    // Zerwanie strumienia zabija `end`; bez jawnego rozstrzygnięcia w gałęzi
    // przepełnienia ta asercja nigdy by nie wróciła.
    expect(await probeServer(`http://127.0.0.1:${huge.address().port}`)).toEqual({ ok: false, error: "not_multibot" });
    huge.close();
  });

  it("budżet czasu tnie serwer, który przyjął żądanie i milczy", async () => {
    const silent = createServer(() => {});
    await new Promise((done) => silent.listen(0, "127.0.0.1", done));
    const started = Date.now();
    expect(await probeServer(`http://127.0.0.1:${silent.address().port}`, { timeoutMs: 300 })).toEqual({
      ok: false,
      error: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(3000);
    silent.close();
  });

  // `agent: false` znaczy w node „nowy agent", a nie „bez agenta" — a
  // `createConnection` z opcji jest brane pod uwagę WYŁĄCZNIE wtedy, gdy agenta
  // nie ma wcale. Pomyłka tutaj nie psuje testów klasyfikacji: po prostu adres
  // .onion jechałby do resolvera DNS zamiast do tunelu.
  it("adres .onion łączy się wstrzykniętym tunelem, a nie zwykłym gniazdem", async () => {
    const fake = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ serverId: "mbs_1", configured: true }));
    });
    await new Promise((done) => fake.listen(0, "127.0.0.1", done));
    const onion = "a".repeat(56) + ".onion";
    const seen = [];
    const createConnection = (options, callback) => {
      seen.push({ host: options.host ?? options.hostname, port: Number(options.port) });
      const socket = netConnect(fake.address().port, "127.0.0.1");
      socket.once("connect", () => callback(null, socket));
      socket.once("error", callback);
      return undefined;
    };
    expect(await probeServer(`http://${onion}:8799`, { createConnection })).toEqual({ ok: true, configured: true, tlsFingerprint: undefined });
    expect(seen).toEqual([{ host: onion, port: 8799 }]);
    fake.close();
  });
});
