// Self-check dla remote-ui.mjs. Zero zależności:
// `node --test electron/remote-ui.test.mjs`.
//
// Sprawdzamy to, na czym stoi cała zmiana: interfejs ma iść z PACZKI, a dane
// z hosta — i jedno nie może zjeść drugiego. Atrapa hosta udaje telefon, więc
// test przechodzi bez sieci, bez tokenu i bez żywego serwera.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, globalAgent, get as httpGet, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { startRemoteUiServer } from "./remote-ui.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Atrapa telefonu: własny `index.html`, echo nagłówków i prawdziwy handshake WS. */
function startFakeHost() {
  const seen = { auth: null, wsProtocol: null, wsUrl: null, fromClient: null };
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>INTERFEJS Z HOSTA</html>");
      return;
    }
    if (req.url === "/pulapka") {
      // Host próbuje podać WŁASNY ekran pod adresem spoza paczki.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html>EKRAN Z HOSTA</html>");
      return;
    }
    if (req.url.startsWith("/api/ping")) {
      seen.auth = req.headers.authorization ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: "host", path: req.url }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "brak trasy", path: req.url }));
  });
  server.on("upgrade", (req, socket) => {
    seen.wsProtocol = req.headers["sec-websocket-protocol"] ?? null;
    seen.wsUrl = req.url ?? null;
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "upgrade: websocket\r\nconnection: Upgrade\r\n" +
        `sec-websocket-accept: ${accept}\r\n\r\n`,
    );
    socket.write("Z-HOSTA");
    socket.on("data", (chunk) => {
      seen.fromClient = chunk.toString();
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function get(url, headers = {}) {
  return new Promise((done, fail) => {
    httpGet(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", fail);
  });
}

const staticDir = mkdtempSync(join(tmpdir(), "multibot-ui-"));
mkdirSync(join(staticDir, "assets"));
mkdirSync(join(staticDir, "api"));
writeFileSync(join(staticDir, "index.html"), "<html><head><title>x</title></head><body>INTERFEJS Z PACZKI</body></html>");
writeFileSync(join(staticDir, "assets", "index-abc123.js"), "console.log('z paczki')");
// Pułapka: plik o nazwie trasy API. Nie wolno go nigdy oddać zamiast hosta.
writeFileSync(join(staticDir, "api", "ping"), "PODSZYWKA");

const host = await startFakeHost();
const ui = await startRemoteUiServer({ staticDir, remoteUrl: host.url });
assert.ok(ui, "lokalny origin powinien wstać");

after(async () => {
  // Domyślny agent HTTP trzyma od Node 19 połączenia przy życiu (`keepAlive`),
  // a otwarte gniazdo klienta wystarczy, żeby `node --test` wisiał do timeoutu
  // mimo zielonych asercji. Zamykamy je jawnie — po stronie klienta i proxy.
  globalAgent.destroy();
  await ui.close();
  // Atrapa też musi rozerwać gniazda po WebSockecie, inaczej `node --test`
  // wisi do timeoutu na otwartych uchwytach mimo zielonych asercji.
  host.server.closeAllConnections();
  host.server.close();
  rmSync(staticDir, { recursive: true, force: true });
});

test("`/` oddaje interfejs z paczki, nie z hosta", async () => {
  const res = await get(`${ui.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.body, /INTERFEJS Z PACZKI/);
  assert.doesNotMatch(res.body, /INTERFEJS Z HOSTA/);
  // Po aktualizacji użytkownik musi dostać nowy ekran, nie ten z cache.
  assert.equal(res.headers["cache-control"], "no-cache");
});

test("index.html z proxy niesie flagę trybu zdalnego, inne pliki nie", async () => {
  for (const path of ["/", "/index.html"]) {
    const res = await get(`${ui.url}${path}`);
    assert.match(res.body, /window\.__MULTIBOT_REMOTE__=true/, `${path} musi nieść flagę`);
    // Bez tego przeglądarka ucina koniec dokumentu o długość flagi.
    assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(res.body), "długość liczona po wstrzyknięciu");
    assert.match(res.body, /<script>window\.__MULTIBOT_REMOTE__=true;window\.__MULTIBOT_HOST__=".+?"<\/script><\/head>/, "flaga przed </head>");
    // Bez adresu hosta ekran logowania pokazywałby origin proxy i nie miałby
    // dokąd wysłać `joinHost` — czyli ekran wyboru zamiast wejścia na serwer.
    assert.ok(res.body.includes(`window.__MULTIBOT_HOST__=${JSON.stringify(host.url)}`), `${path} musi nieść adres hosta`);
  }
  const asset = await get(`${ui.url}/assets/index-abc123.js`);
  assert.doesNotMatch(asset.body, /__MULTIBOT_REMOTE__/, "pliki statyczne zostają nietknięte");
});

test("pliki z assets/ idą z dysku i mają hash w nazwie, więc mogą leżeć w cache", async () => {
  const res = await get(`${ui.url}/assets/index-abc123.js`);
  assert.equal(res.status, 200);
  assert.match(res.body, /z paczki/);
  assert.match(res.headers["content-type"], /javascript/);
  assert.match(res.headers["cache-control"], /immutable/);
});

test("dane i nagłówek uwierzytelnienia jadą na hosta", async () => {
  const res = await get(`${ui.url}/api/ping?x=1`, { authorization: "Bearer test-token" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { from: "host", path: "/api/ping?x=1" });
  assert.equal(host.seen.auth, "Bearer test-token", "token musi dojść do hosta nietknięty");
});

test("pliku z paczki nie da się podstawić pod trasę API", async () => {
  const res = await get(`${ui.url}/api/ping`);
  assert.doesNotMatch(res.body, /PODSZYWKA/);
  assert.equal(JSON.parse(res.body).from, "host");
});

test("nieznana ścieżka spoza paczki leci na hosta razem z jego statusem", async () => {
  const res = await get(`${ui.url}/nie-ma-takiego`);
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error, "brak trasy");
});

test("WebSocket przechodzi przez proxy w obie strony razem z subprotokołem", async () => {
  const { port } = new URL(ui.url);
  const upgraded = await new Promise((done, fail) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/events",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        "sec-websocket-version": "13",
        "sec-websocket-protocol": "multibot-auth, test-token",
      },
    });
    req.on("upgrade", (res, socket, head) => done({ res, socket, head }));
    req.on("response", (res) => fail(new Error(`zamiast 101 przyszło ${res.statusCode}`)));
    req.on("error", fail);
    req.end();
  });

  assert.equal(upgraded.res.statusCode, 101);
  assert.equal(
    host.seen.wsProtocol,
    "multibot-auth, test-token",
    "subprotokół niesie token — proxy nie może go tknąć",
  );

  const fromHost = await new Promise((done) => {
    if (upgraded.head?.length) return done(upgraded.head.toString());
    upgraded.socket.once("data", (chunk) => done(chunk.toString()));
  });
  assert.equal(fromHost, "Z-HOSTA", "ramki z hosta muszą dojść do klienta");

  upgraded.socket.write("OD-KLIENTA");
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(host.seen.fromClient, "OD-KLIENTA", "ramki klienta muszą dojść do hosta");
  upgraded.socket.destroy();
});

// Ekran komputera (noVNC) wchodzi na hosta INNYM upgradem niż czat: token
// jedzie w query (`?token=`), a nie w subprotokole, i noVNC prosi o subprotokół
// `binary`. Obcięcie query albo podmiana subprotokołu po drodze kończy się
// odrzuconym handshakiem i pustym ekranem komputera, więc oba są tu przybite.
test("upgrade websockify idzie na hosta z query i subprotokołem `binary`", async () => {
  const { port } = new URL(ui.url);
  const path = "/api/bots/bot-1/computer/vnc/websockify?token=sekret%2F%3D";
  const upgraded = await new Promise((done, fail) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.from("fedcba9876543210").toString("base64"),
        "sec-websocket-version": "13",
        "sec-websocket-protocol": "binary",
      },
    });
    req.on("upgrade", (res, socket) => done({ res, socket }));
    req.on("response", (res) => fail(new Error(`zamiast 101 przyszło ${res.statusCode}`)));
    req.on("error", fail);
    req.end();
  });

  assert.equal(upgraded.res.statusCode, 101);
  assert.equal(host.seen.wsUrl, path, "query z tokenem musi dojść do hosta nietknięte");
  assert.equal(host.seen.wsProtocol, "binary", "subprotokół noVNC nie może być podmieniony");
  upgraded.socket.destroy();
});

test("HTML od hosta spoza /api nie wchodzi do okna — origin proxy to nie miejsce na cudzy ekran", async () => {
  const odpowiedz = await get(`${ui.url}/pulapka`);
  assert.equal(odpowiedz.status, 502, "cudzy HTML ma dostać odmowę, nie trafić do renderera");
  assert.match(odpowiedz.body, /HTML outside/);
  assert.doesNotMatch(odpowiedz.body, /EKRAN Z HOSTA/);
});

test("host po https bez przypiętego certyfikatu nie dostaje proxy w ogóle", async () => {
  await assert.rejects(
    () => startRemoteUiServer({ staticDir, remoteUrl: "https://przyklad.invalid:8799" }),
    /certificate pin/,
    "bez przypięcia `rejectUnauthorized:false` znaczyłoby „ufam każdemu\"",
  );
});

test("adres hosta wstrzykiwany jest jako literał, więc `</script>` w nim nic nie zamyka", async () => {
  const zlosliwy = await startRemoteUiServer({ staticDir, remoteUrl: "http://zly.invalid/</script><script>window.x=1" });
  const res = await get(`${zlosliwy.url}/`);
  await zlosliwy.close();
  const glowa = res.body.slice(0, res.body.indexOf("</head>"));
  assert.doesNotMatch(glowa, /<\/script><script>window\.x=1/, "adres nie może wyjść z bloku skryptu");
  assert.match(glowa, /\\u003c\/script>/, "`<` ucieka jako \\u003c");
});

// `String.replace` z ŁAŃCUCHEM zastępującym rozwija w nim `$&`, ``$` ``, `$'`
// i `$$` — już PO naszym uciekaniu `<`. Adres z ``$` `` wklejał więc w miejsce
// flagi całą głowę dokumentu, a `$'` całą resztę pliku.
test("adres z `$` w środku nie rozwija się we wzorzec zastępujący", async () => {
  // Poprzedni test zajmował ten sam port i go zwolnił, a domyślny agent trzyma
  // do niego martwe gniazdo — bez tego `get` dostaje ECONNRESET zamiast strony.
  globalAgent.destroy();
  const zlosliwy = await startRemoteUiServer({ staticDir, remoteUrl: "http://zly.invalid/$`$&$'" });
  const res = await get(`${zlosliwy.url}/`);
  await zlosliwy.close();
  assert.ok(
    res.body.includes(`window.__MULTIBOT_HOST__=${JSON.stringify("http://zly.invalid/$`$&$'")}`),
    "adres ma trafić do okna dosłownie",
  );
  assert.equal(res.body.match(/<title>/g).length, 1, "nic z dokumentu nie może się zduplikować");
  assert.equal(Number(res.headers["content-length"]), Buffer.byteLength(res.body));
});

// Bez tego `remoteUrl` był oglądany wyłącznie w gałęzi `!pin`, więc z
// przypięciem w ręku `undefined` jechało dalej — aż na ekran logowania do
// serwera o nazwie „undefined".
test("brak adresu hosta jest błędem od razu, także gdy przypięcie jest w ręku", async () => {
  await assert.rejects(() => startRemoteUiServer({ staticDir, remoteUrl: undefined, pin: { get: () => "AA", set: () => {} } }), /Invalid URL/);
});

test("brak zapakowanego interfejsu degraduje do trybu sprzed zmiany, nie do białego ekranu", async () => {
  const pusty = mkdtempSync(join(tmpdir(), "multibot-ui-pusty-"));
  const wynik = await startRemoteUiServer({ staticDir: pusty, remoteUrl: host.url });
  assert.equal(wynik, null, "bez index.html main.mjs ma wrócić do ładowania prosto z hosta");
  rmSync(pusty, { recursive: true, force: true });
});
