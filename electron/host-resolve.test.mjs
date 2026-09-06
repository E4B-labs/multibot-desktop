// Testy host-resolve.mjs. Pod vitest (`pnpm test`) — wcześniej leżały pod
// node:test i nie uruchamiał ich nikt (docs/engineering/REPO_STATE.md §6).
import { describe, expect, it } from "vitest";

import {
  normalizeRemoteUrl,
  removeRemoteHost,
  resolveActiveTarget,
  shouldStartLocalHarness,
  upsertRemoteHost,
} from "./host-resolve.mjs";

describe("host resolve", () => {
  it("normalizeRemoteUrl strips trailing slashes and validates scheme", () => {
    expect(normalizeRemoteUrl("https://host.ts.net/")).toBe("https://host.ts.net");
    expect(normalizeRemoteUrl(" http://127.0.0.1:8799// ")).toBe("http://127.0.0.1:8799");
    expect(() => normalizeRemoteUrl("not-a-url")).toThrow();
    expect(() => normalizeRemoteUrl("")).toThrow();
  });

  it("normalizeRemoteUrl fills https:// in for a bare address:port", () => {
    // Tak wygląda adres z trzech wartości serwera przepisany z drugiego
    // urządzenia. Serwer 0.4.0 słucha wyłącznie po HTTPS, więc schemat jest
    // rozstrzygnięty, a nie zgadywany.
    expect(normalizeRemoteUrl("192.168.1.42:8799")).toBe("https://192.168.1.42:8799");
    expect(normalizeRemoteUrl(" [2a00:f41:8c4:1::7]:8799/ ")).toBe("https://[2a00:f41:8c4:1::7]:8799");
    expect(normalizeRemoteUrl("brave-otter.local:8799")).toBe("https://brave-otter.local:8799");
    // Bez portu to już zgadywanie — zostaje błąd, tak samo jak port spoza zakresu.
    expect(() => normalizeRemoteUrl("192.168.1.42")).toThrow();
    expect(() => normalizeRemoteUrl("192.168.1.42:99999")).toThrow();
    expect(() => normalizeRemoteUrl("192.168.1.42:0")).toThrow();
  });

  it("upsertRemoteHost replaces by id and keeps newest first", () => {
    const a = { id: "a", name: "A", url: "https://a" };
    const b = { id: "b", name: "B", url: "https://b" };
    const list = upsertRemoteHost([a], b);
    expect(list).toEqual([b, a]);

    const a2 = { id: "a", name: "A2", url: "https://a2" };
    expect(upsertRemoteHost(list, a2)).toEqual([a2, b]);
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
