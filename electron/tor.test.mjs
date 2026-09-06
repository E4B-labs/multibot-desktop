// Self-check dla tor.mjs. Zero zależności i ZERO tora:
// `node --test electron/tor.test.mjs`.
//
// Nadzorca czyta z tora dokładnie dwie rzeczy — numer portu SOCKS i „gotowe" —
// i obie wyjmuje regexem z logu. To jest ta część, którą trzeba przybić, bo
// zmiana brzmienia jednej linijki w torze zamienia ją w ciche 90 sekund czekania.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { parseTorLine, resolveTorBinary, startTor, TOR_UNAVAILABLE, torrcText } from "./tor.mjs";

test("z logu tora wychodzi port SOCKS i moment gotowości", () => {
  assert.deepEqual(parseTorLine("Sep 06 12:00:00.000 [notice] Opened Socks listener on 127.0.0.1:53422"), { socksPort: 53422 });
  // Nowsze wydania wtrącają w to zdanie własne słowa — kotwice są na końcach.
  assert.deepEqual(parseTorLine("[notice] Opened Socks listener connection (ready) on 127.0.0.1:9150"), { socksPort: 9150 });
  assert.deepEqual(parseTorLine("[notice] Bootstrapped 100% (done): Done"), { bootstrapped: true });
  assert.equal(parseTorLine("[notice] Bootstrapped 45% (requesting_descriptors)"), null);
  // Nasłuch na innym interfejsie to NIE jest nasz port na pętli zwrotnej.
  assert.equal(parseTorLine("[notice] Opened Socks listener on 0.0.0.0:9050"), null);
  assert.equal(parseTorLine("[notice] Bootstrapped 0% (starting)"), null);
});

test("torrc klienta nigdy nie robi z tej maszyny przekaźnika", () => {
  const text = torrcText({ dataDir: "/home/k/.config/MultiBot/tor" });
  assert.match(text, /^ClientOnly 1$/m, "bez tego komputer użytkownika zaczyna przekazywać cudzy ruch");
  assert.match(text, /^SocksPort auto$/m);
  assert.match(text, /^DataDirectory \/home\/k\/\.config\/MultiBot\/tor$/m);
  assert.doesNotMatch(text, /HiddenService/, "klient nie wystawia usługi — to robi serwer");
  // PR 3 wiezie samo `tor.exe`, bez plików geoip — wskazywanie nieistniejących
  // ścieżek dałoby tylko ostrzeżenie w logu.
  assert.doesNotMatch(text, /GeoIP/);
});

test("ścieżka ze spacją jedzie w cudzysłowie, a jej backslashe są podwojone", () => {
  // Windows: `C:\Program Files\…`. Bez cudzysłowu tor urywa wartość na spacji,
  // a w cudzysłowie pojedynczy backslash jest znakiem ucieczki.
  const text = torrcText({ dataDir: "C:\\Program Files\\MultiBot\\tor" });
  assert.match(text, /^DataDirectory "C:\\\\Program Files\\\\MultiBot\\\\tor"$/m);
});

test("binarka: paczka na Windowsie, potem PATH, potem furtka dla dewelopera", () => {
  const exists = (list) => (path) => list.includes(path);

  // Ścieżki składamy `join`em, nie ręcznie: tak samo składa je `resolveTorBinary`,
  // a separator zależy od maszyny, na której akurat leci ten test.
  const onPath = join("C:\\bin", "tor.exe");
  const bundled = join("C:\\res", "tor", "tor.exe");

  assert.equal(
    resolveTorBinary({ resourcesPath: "C:\\res", platform: "win32", env: { PATH: "C:\\bin" }, exists: exists([bundled, onPath]) }),
    bundled,
    "dołączona kopia bije systemową",
  );
  assert.equal(resolveTorBinary({ resourcesPath: "C:\\res", platform: "win32", env: { PATH: "C:\\bin" }, exists: exists([onPath]) }), onPath);
  assert.equal(
    resolveTorBinary({ platform: "win32", env: { PATH: "C:\\bin", OMB_TOR_BIN: "D:\\tor\\tor.exe" }, exists: exists(["D:\\tor\\tor.exe"]) }),
    "D:\\tor\\tor.exe",
  );
  // Wyłącznik z PLAN-TOR działa nawet wtedy, gdy binarka leży pod ręką.
  assert.equal(resolveTorBinary({ platform: "win32", env: { OMB_TOR: "0", PATH: "C:\\bin" }, exists: exists([onPath]) }), null);
});

test("bez tora na tym komputerze nie ma czego szukać — to jest ten jeden kod", () => {
  assert.equal(resolveTorBinary({ platform: "win32", env: { PATH: "C:\\bin" }, exists: () => false }), null);
});

test("startTor bez binarki odpada od razu kodem tor_unavailable, a nie po 90 sekundach", async () => {
  const before = process.env.OMB_TOR;
  process.env.OMB_TOR = "0";
  try {
    await assert.rejects(() => startTor({ dataDir: null }), (err) => err.code === TOR_UNAVAILABLE);
    // Nieudany start NIE zostaje na całe życie procesu: kto doinstaluje tora,
    // ma prawo spróbować jeszcze raz bez restartu aplikacji.
    await assert.rejects(() => startTor(), (err) => err.code === TOR_UNAVAILABLE);
  } finally {
    if (before === undefined) delete process.env.OMB_TOR;
    else process.env.OMB_TOR = before;
  }
});
