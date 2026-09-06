// Czytanie setup.json: czyste funkcje, bez Electrona i bez dysku. To one
// decydują, czy ekran „postaw serwer" pokaże trzy wartości, czy powie, że
// serwer jest już zajęty.
import path from "node:path";

import { describe, expect, it } from "vitest";

import { collectSetupValues, fetchSetupRoute, parseSetupFile, setupFilePath, setupValuesFrom } from "./setup-values.mjs";

describe("parseSetupFile", () => {
  it("czyta trzy pola świeżego serwera", () => {
    expect(parseSetupFile(JSON.stringify({ serverName: "brave-otter", serverPassword: "7f3k", setupToken: "tok", createdAt: 1 }))).toEqual({
      serverName: "brave-otter",
      serverPassword: "7f3k",
      setupToken: "tok",
    });
  });

  it("brak pliku, ucięty zapis i pusty JSON to to samo: nie ma czego pokazać", () => {
    expect(parseSetupFile("")).toBeNull();
    expect(parseSetupFile("{\"serverName\": \"brave")).toBeNull();
    expect(parseSetupFile("null")).toBeNull();
    expect(parseSetupFile("[]")).toBeNull();
  });

  it("adres i odcisk z pliku są opcjonalne, ale przechodzą, gdy są", () => {
    expect(parseSetupFile(JSON.stringify({ serverName: "brave-otter", serverPassword: "7f3k", setupToken: "tok", address: "https://10.0.0.5:8799", tlsFingerprint: "AA:BB" }))).toEqual({
      serverName: "brave-otter",
      serverPassword: "7f3k",
      setupToken: "tok",
      address: "https://10.0.0.5:8799",
      tlsFingerprint: "AA:BB",
    });
  });

  it("bez któregokolwiek z trzech pól plik jest bezużyteczny", () => {
    expect(parseSetupFile(JSON.stringify({ serverName: "brave-otter", serverPassword: "7f3k" }))).toBeNull();
    expect(parseSetupFile(JSON.stringify({ serverName: "", serverPassword: "7f3k", setupToken: "tok" }))).toBeNull();
    expect(parseSetupFile(JSON.stringify({ serverPassword: "7f3k", setupToken: "tok" }))).toBeNull();
  });
});

describe("setupValuesFrom", () => {
  const file = { serverName: "brave-otter", serverPassword: "7f3k", setupToken: "tok" };

  it("NIGDY nie wypuszcza tokenu setupu do renderera", () => {
    const values = setupValuesFrom(file, null);
    expect(values.setupToken).toBeUndefined();
    expect(JSON.stringify(values)).not.toContain("tok");
  });

  it("bez odpowiedzi serwera zostają same poświadczenia, adres pusty", () => {
    expect(setupValuesFrom(file, null)).toEqual({ serverName: "brave-otter", serverPassword: "7f3k", address: "" });
  });

  it("adres, certyfikat i sposób znalezienia adresu są serwera, nie nasze", () => {
    expect(setupValuesFrom(file, { address: "https://192.168.1.42:8799", tlsFingerprint: "AA:BB", addressKind: "ipv4-lan", addressVerified: false })).toEqual({
      serverName: "brave-otter",
      serverPassword: "7f3k",
      address: "https://192.168.1.42:8799",
      tlsFingerprint: "AA:BB",
      addressKind: "ipv4-lan",
      addressVerified: false,
    });
  });

  it("nie ma pliku — nie ma trybu setupu", () => {
    expect(setupValuesFrom(null, { address: "https://x" })).toBeNull();
  });
});

describe("setupFilePath", () => {
  it("idzie za OMB_DATA_DIR, tak samo jak server/config.ts", () => {
    expect(setupFilePath({ OMB_DATA_DIR: "/data/mb" }, "/home/k")).toBe(path.join("/data/mb", "setup.json"));
    expect(setupFilePath({}, "/home/k")).toBe(path.join("/home/k", ".openmausbot", "setup.json"));
    expect(setupFilePath({ OMB_DATA_DIR: "   " }, "/home/k")).toBe(path.join("/home/k", ".openmausbot", "setup.json"));
  });
});

describe("fetchSetupRoute", () => {
  it("dowodzi tokenem z pliku, że umie go przeczytać", async () => {
    const seen = [];
    const get = async (url, options) => {
      seen.push([url, options]);
      return { status: 200, json: { serverName: "brave-otter", address: "https://10.0.0.5:8799" } };
    };
    expect(await fetchSetupRoute(get, "https://127.0.0.1:8799", "tok")).toEqual({ serverName: "brave-otter", address: "https://10.0.0.5:8799" });
    expect(seen).toEqual([["https://127.0.0.1:8799/api/setup/values", { headers: { "x-multibot-setup": "tok" } }]]);
  });

  it("cokolwiek innego niż 200 znaczy: serwer nie ma nic do dodania", async () => {
    expect(await fetchSetupRoute(async () => ({ status: 404, json: { error: "not_found" } }), "https://127.0.0.1:8799", "tok")).toBeNull();
    expect(await fetchSetupRoute(async () => ({ status: 0, json: null }), "https://127.0.0.1:8799", "tok")).toBeNull();
  });
});

describe("collectSetupValues", () => {
  it("bez pliku nie pyta nawet serwera", async () => {
    let called = false;
    const get = async () => { called = true; return { status: 200, json: {} }; };
    expect(await collectSetupValues(get, "https://127.0.0.1:8799", "/nie/ma/takiego/setup.json")).toBeNull();
    expect(called).toBe(false);
  });
});
