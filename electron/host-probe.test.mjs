// Klasyfikacja odpowiedzi serwera — czyste funkcje, bez gniazd. To one
// decydują, co zobaczy pole adresu, nazwy albo hasła na ekranie logowania.
import { describe, expect, it } from "vitest";

import { classifyJoin, classifyProbe, failureCode } from "./host-probe.mjs";
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
    expect(classifyProbe(200, { hello: "nginx" })).toEqual({ ok: false, error: "not-multibot" });
    expect(classifyProbe(200, null)).toEqual({ ok: false, error: "not-multibot" });
    expect(classifyProbe(404, { serverId: "mbs_1" })).toEqual({ ok: false, error: "not-multibot" });
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

  it("kod błędu serwera przechodzi nietknięty — formularz wskazuje po nim pole", () => {
    expect(classifyJoin(401, { error: "wrong_server_password" })).toEqual({ ok: false, error: "wrong_server_password" });
    expect(classifyJoin(404, { error: "server_not_set_up" })).toEqual({ ok: false, error: "server_not_set_up" });
  });

  it("404 bez kodu to serwer bez tej trasy, czyli nie ten serwer", () => {
    expect(classifyJoin(404, null)).toEqual({ ok: false, error: "not-multibot" });
    expect(classifyJoin(500, null)).toEqual({ ok: false, error: "http_500" });
  });
});

describe("failureCode", () => {
  it("rozdziela ciszę, przeterminowanie i podmieniony certyfikat", () => {
    expect(failureCode({ code: "ECONNREFUSED" })).toBe("unreachable");
    expect(failureCode({ code: "MULTIBOT_TIMEOUT" })).toBe("timeout");
    expect(failureCode({ code: CERT_CHANGED })).toBe("certificate_changed");
  });
});
