// Self-check dla socks5.mjs. Zero zależności:
// `node --test electron/socks5.test.mjs`.
//
// Atrapa proxy mówi protokołem z RFC 1928, więc test przechodzi bez tora, bez
// sieci i bez adresu .onion. Sprawdzamy trzy rzeczy, na których stoi tunel:
// nazwa celu jedzie jako DOMENA (czyli nigdy nie trafia do resolvera), udany
// uścisk oddaje gniazdo gotowe do czytania, a każda odmowa jest błędem, nie
// cichym gniazdem donikąd.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, test } from "node:test";

import { socksConnect } from "./socks5.mjs";

const ONION = "a".repeat(56) + ".onion";
const servers = [];

/**
 * @param {"ok"|"auth-refused"|"refused"|"garbage"} mode
 * `withPayload` dokleja bajty celu do TEJ SAMEJ ramki co odpowiedź — tak
 * wygląda serwer, który odzywa się pierwszy. Bez `unshift` w socks5.mjs te
 * bajty przepadały.
 */
function fakeSocks(mode, { withPayload = false } = {}) {
  const seen = { greeting: null, request: null };
  // `net.Server` nie ma `closeAllConnections` (to metoda serwera HTTP), a samo
  // `close()` czeka na otwarte gniazda — bez tego rejestru `node --test` wisi
  // do timeoutu mimo zielonych asercji.
  const open = new Set();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let stage = "greeting";
    socket.on("data", (chunk) => {
      if (stage === "greeting") {
        seen.greeting = Buffer.from(chunk);
        stage = "request";
        if (mode === "auth-refused") return socket.end(Buffer.from([0x05, 0xff]));
        if (mode === "garbage") return socket.end(Buffer.from([0x04, 0x00]));
        return socket.write(Buffer.from([0x05, 0x00]));
      }
      seen.request = Buffer.from(chunk);
      const reply = Buffer.from([0x05, mode === "refused" ? 0x05 : 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
      socket.write(withPayload ? Buffer.concat([reply, Buffer.from("Z-CELU")]) : reply);
    });
    socket.on("error", () => {});
  });
  servers.push({ server, open });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ seen, port: server.address().port })));
}

after(() => {
  for (const { server, open } of servers) {
    for (const socket of open) socket.destroy();
    server.close();
  }
});

test("udany CONNECT oddaje gniazdo, a cel jedzie jako NAZWA, nie jako adres", async () => {
  const proxy = await fakeSocks("ok", { withPayload: true });
  const socket = await socksConnect({ socksPort: proxy.port, host: ONION, port: 8799 });

  assert.deepEqual([...proxy.seen.greeting], [0x05, 0x01, 0x00], "prosimy o połączenie bez uwierzytelnienia");
  const request = proxy.seen.request;
  assert.equal(request[1], 0x01, "CONNECT");
  assert.equal(request[3], 0x03, "ATYP musi być DOMENA — inaczej nazwę rozwiązywałby ten komputer");
  assert.equal(request[4], ONION.length);
  assert.equal(request.subarray(5, 5 + ONION.length).toString(), ONION);
  assert.equal(request.readUInt16BE(5 + ONION.length), 8799, "port big-endian");

  // Bajty przysłane razem z odpowiedzią należą już do celu i muszą dojść do
  // tego, kto weźmie to gniazdo — inaczej TLS zaczyna od uciętego uścisku.
  // Czytamy je z BUFORA, bo gniazdo wraca zapauzowane: tak samo wyjmuje je
  // `tls.connect` (`initRead` woła `socket.read()`), zanim cokolwiek popłynie.
  assert.equal(socket.read().toString(), "Z-CELU");
  assert.equal(socket.isPaused(), true, "właściciel gniazda ma decydować, kiedy ruszy strumień");
  socket.destroy();
});

test("proxy, które nie chce połączenia bez uwierzytelnienia, jest błędem", async () => {
  const proxy = await fakeSocks("auth-refused");
  await assert.rejects(() => socksConnect({ socksPort: proxy.port, host: ONION, port: 8799 }), /unauthenticated/);
});

test("odmowa celu wraca jako błąd z powodem, nie jako gniazdo donikąd", async () => {
  const proxy = await fakeSocks("refused");
  await assert.rejects(() => socksConnect({ socksPort: proxy.port, host: ONION, port: 8799 }), /connection refused/);
});

test("port, który nie mówi SOCKS5, jest błędem od pierwszego bajtu", async () => {
  const proxy = await fakeSocks("garbage");
  await assert.rejects(() => socksConnect({ socksPort: proxy.port, host: ONION, port: 8799 }), /not a SOCKS5 proxy/);
});

test("martwy port tora nie wiesza wołającego", async () => {
  // Nikt tu nie słucha: gniazdo odpada od razu, a obietnica musi odpaść z nim.
  await assert.rejects(() => socksConnect({ socksPort: 1, host: ONION, port: 8799, timeoutMs: 2000 }), (err) => Boolean(err));
});

test("nazwa i port poza zakresem odpadają, zanim cokolwiek pójdzie w sieć", async () => {
  await assert.rejects(() => socksConnect({ socksPort: 9050, host: "", port: 8799 }), /1-255 bytes/);
  await assert.rejects(() => socksConnect({ socksPort: 9050, host: "x".repeat(256), port: 8799 }), /1-255 bytes/);
  await assert.rejects(() => socksConnect({ socksPort: 9050, host: ONION, port: 0 }), /out of range/);
});
