// Zapamiętane logowanie: co ląduje na dysku i co z niego wraca. safeStorage
// jest podmieniony na odwracalną atrapę — sprawdzamy REGUŁY (nigdy jawnie, pół
// rekordu to jeszcze nie oferta, „zapomnij" kasuje plik), nie kryptografię
// Electrona.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forgetRemembered, readRemembered, rememberedEntry, rememberProfile, writeRemembered } from "./remember.mjs";

// Odwracalna „szyfrowanie": base64 z prefiksem, żeby test widział, że wartość
// naprawdę przeszła przez safeStorage, a nie wylądowała w pliku wprost.
const fakeStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`k:${text}`, "utf8"),
  decryptString: (buffer) => {
    const text = buffer.toString("utf8");
    if (!text.startsWith("k:")) throw new Error("not ours");
    return text.slice(2);
  },
};

const noStore = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" };

const server = { url: "https://10.0.0.5:8799", serverName: "brave-otter", serverPassword: "7f3k-92xa" };
const full = { ...server, username: "kacper", password: "correct horse battery" };

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-remember-"));
  file = path.join(dir, "nested", "remembered-login.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeRemembered / readRemembered", () => {
  it("zapisuje i czyta cały rekord, zakładając katalog po drodze", () => {
    expect(writeRemembered(file, fakeStore, full)).toBe(true);
    expect(readRemembered(file, fakeStore)).toEqual(full);
  });

  it("żadne hasło nie leży w pliku jawnie", () => {
    writeRemembered(file, fakeStore, full);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(full.password);
    expect(raw).not.toContain(server.serverPassword);
  });

  it("bez magazynu poświadczeń nie zapisuje NICZEGO — zamiast pliku jawnego", () => {
    expect(writeRemembered(file, noStore, full)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("brak pliku, ucięty JSON i cudzy blob to jedno: nie ma zapamiętanego logowania", () => {
    expect(readRemembered(file, fakeStore)).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{\"enc\": \"AA", "utf8");
    expect(readRemembered(file, fakeStore)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ enc: Buffer.from("obcy", "utf8").toString("base64") }), "utf8");
    expect(readRemembered(file, fakeStore)).toBeNull();
  });
});

describe("rememberedEntry", () => {
  it("oddaje wyłącznie adres, nazwę serwera i nazwę profilu — żadnego hasła", () => {
    writeRemembered(file, fakeStore, full);
    expect(rememberedEntry(file, fakeStore)).toEqual({ url: full.url, serverName: "brave-otter", username: "kacper" });
  });

  it("sam serwer, bez profilu, to jeszcze nie jest oferta jednego kliknięcia", () => {
    writeRemembered(file, fakeStore, server);
    expect(rememberedEntry(file, fakeStore)).toBeNull();
  });
});

describe("rememberProfile", () => {
  it("dokłada drugą połowę do rekordu czekającego po zalogowaniu do serwera", () => {
    writeRemembered(file, fakeStore, server);
    expect(rememberProfile(file, fakeStore, "kacper", "correct horse battery")).toBe(true);
    expect(readRemembered(file, fakeStore)).toEqual(full);
  });

  it("bez czekającego rekordu nic nie zapisuje — „zapamiętaj mnie" było wyłączone", () => {
    expect(rememberProfile(file, fakeStore, "kacper", "correct horse battery")).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("forgetRemembered", () => {
  it("kasuje plik, a na braku pliku nie wywraca się", () => {
    writeRemembered(file, fakeStore, full);
    expect(forgetRemembered(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(forgetRemembered(file)).toBe(true);
    expect(rememberedEntry(file, fakeStore)).toBeNull();
  });
});
