// multibot: LOKALNY ORIGIN DLA TRYBU ZDALNEGO.
//
// Wcześniej `loadActiveTarget` w trybie zdalnym robiło `loadURL` prosto na
// adres hosta, więc z telefonu przychodził CAŁY interfejs, a nie tylko dane.
// Skutek: poprawka wyglądu aplikacji na komputerze nie docierała do
// użytkownika ANI przez aktualizację, ANI przez ponowną instalację —
// instalator wiózł ekran (`resources/ui`), którego apka w tym trybie nigdy
// nie otwierała. Jedyną drogą było ręczne wgranie `dist` na telefon.
//
// Teraz apka podnosi u siebie mały serwer na 127.0.0.1, który:
//   * oddaje ZAPAKOWANY interfejs — ten, który przyszedł z aktualizacją,
//   * a każde inne żądanie przepuszcza na hosta, razem z WebSocketem.
//
// Renderer jest dzięki temu same-origin ze swoim API, więc względne adresy
// (`/api/...`) i `wss://${location.host}/api/events` działają bez zmiany
// jednej linijki w `src/`. CORS w ogóle nie wchodzi w grę — zmierzone: serwer
// nie wysyła żadnych nagłówków CORS, więc ładowanie interfejsu z obcego
// originu wymagałoby dopisywania ich po drodze.
//
// Proxy NIE dokłada tokenu. Przepuszcza wyłącznie nagłówek przysłany przez
// renderer, więc inny lokalny proces, który trafi na ten port, dostanie z
// telefonu 401 dokładnie tak samo jak z sieci.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, resolve, sep } from "node:path";

import { CERT_CHANGED, pinRequest } from "./tls-pin.mjs";

// Nagłówki jednego skoku — przepisanie ich psuje ramkowanie odpowiedzi.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"];

// Port musi być STAŁY między uruchomieniami, bo `localStorage` jest per origin:
// na losowym porcie apka co start gubiłaby język, zwinięcie panelu i resztę
// ustawień interfejsu. Bierzemy pierwszy wolny z wąskiego zakresu — zajęty
// zdarza się w praktyce tylko wtedy, gdy działa druga kopia aplikacji.
const PORT_FIRST = 47820;
const PORT_LAST = 47839;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Plik z zapakowanego interfejsu albo `null`, gdy żądanie ma iść na hosta.
 * `/api/...` nie jest statyczne NIGDY, nawet gdyby ktoś położył taki plik w
 * katalogu UI — inaczej dałoby się przesłonić trasę serwera plikiem z paczki.
 */
function staticFileFor(staticDir, pathname) {
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const full = resolve(staticDir, rel);
  // Zapora na wyjście poza katalog UI (`..%2f` i spółka).
  if (full !== staticDir && !full.startsWith(staticDir + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

/**
 * Znacznik trybu zdalnego dla renderera. Bramka onboardingu w `src/App.tsx`
 * musi rozstrzygnąć SYNCHRONICZNIE, przy montowaniu, czy interfejs przyszedł z
 * tego proxy, czy z lokalnego harnessu — a od czasu, gdy proxy stoi na
 * 127.0.0.1, sam `location.hostname` już ich nie odróżnia. Most `window.ogb`
 * jest asynchroniczny (IPC), więc na tę decyzję za późno. Wstrzykujemy więc
 * flagę prosto w `index.html`, i to WYŁĄCZNIE tutaj: lokalny harness serwuje
 * ten sam plik bez niej.
 */
const REMOTE_FLAG = "<script>window.__MULTIBOT_REMOTE__=true</script>";

function serveStatic(res, file, method) {
  const ext = extname(file).toLowerCase();
  const headers = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    // `index.html` musi być świeży po aktualizacji, a pliki w `assets/` mają
    // hash w nazwie, więc mogą spokojnie leżeć w cache.
    "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  };
  if (file.endsWith("index.html")) {
    // Długość liczymy z treści PO wstrzyknięciu — rozmiar z dysku byłby o
    // flagę za krótki i przeglądarka ucięłaby koniec dokumentu.
    const body = Buffer.from(readFileSync(file, "utf8").replace("</head>", REMOTE_FLAG + "</head>"));
    res.writeHead(200, { ...headers, "content-length": String(body.length) });
    res.end(method === "HEAD" ? undefined : body);
    return;
  }
  if (method === "HEAD") {
    res.writeHead(200, { ...headers, "content-length": String(statSync(file).size) });
    res.end();
    return;
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

function requestFor(target) {
  return target.protocol === "https:" ? httpsRequest : httpRequest;
}

/**
 * `keepHandshake` zostawia `connection`/`upgrade` nietknięte. Dla zwykłego
 * HTTP trzeba je zdjąć, bo dotyczą jednego skoku i psują ramkowanie — ale przy
 * WebSocketcie to WŁAŚNIE one robią z żądania handshake. Bez tego host widzi
 * zwykłe GET, odpowiada 404, kanał zdarzeń nie wstaje i wraca objaw „szarej
 * wiadomości": wysłany dymek nigdy nie gaśnie, choć bot pracuje.
 */
function upstreamOptions(req, remote, { keepHandshake = false } = {}) {
  const target = new URL(req.url ?? "/", remote);
  const headers = { ...req.headers, host: target.host };
  if (!keepHandshake) for (const name of HOP_BY_HOP) delete headers[name];
  return {
    target,
    options: {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers,
      // Hosty 0.4.0 mają certyfikat z własnego podpisu, więc łańcucha nie ma
      // czym sprawdzić; zaufanie stoi na odcisku przypiętym w `pin`
      // (electron/tls-pin.mjs) — bez niego byłoby to gołe „ufam każdemu".
      // ponytail: odcisk sprawdzamy przy uścisku dłoni, więc gniazdo z puli
      // (keep-alive) przechodzi bez ponownego sprawdzenia — podmiana
      // certyfikatu na serwerze wychodzi przy następnym połączeniu, nie w tej
      // samej milisekundzie. Gdyby to kiedyś było za mało: `agent: false`.
      rejectUnauthorized: false,
    },
  };
}

function proxyHttp(req, res, remote, pin) {
  const { target, options } = upstreamOptions(req, remote);
  const upstream = requestFor(target)(options, (up) => {
    const headers = { ...up.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    res.writeHead(up.statusCode ?? 502, headers);
    up.pipe(res);
  });
  if (pin) pinRequest(upstream, pin);
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    // Podmieniony certyfikat to nie „host nieosiągalny" — użytkownik ma
    // zobaczyć dokładnie to zdanie, bo tylko ono mówi, co się stało.
    res.end(JSON.stringify({ error: err.code === CERT_CHANGED ? err.message : `host unreachable: ${err.message}` }));
  });
  req.pipe(upstream);
}

/** Surowa odpowiedź 101 przepisana z góry na dół — ramek nie dotykamy. */
function raw101(upRes) {
  const lines = ["HTTP/1.1 101 Switching Protocols"];
  for (const [name, value] of Object.entries(upRes.headers)) {
    if (Array.isArray(value)) for (const one of value) lines.push(`${name}: ${one}`);
    else lines.push(`${name}: ${value}`);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

function bail(socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\n\r\n`);
  } catch {
    /* gniazdo już zamknięte */
  }
  socket.destroy();
}

/**
 * WebSocket bez biblioteki, ręcznie: powtarzamy handshake w stronę hosta,
 * 101 przepisujemy z powrotem i od tej chwili spinamy gniazda bajt w bajt. Subprotokół zostaje NIETKNIĘTY, bo to
 * w nim jedzie token (`["multibot-v2", <token>]`).
 */
function pipeWs(req, socket, head, remote, live, pin) {
  const { target, options } = upstreamOptions(req, remote, { keepHandshake: true });
  const upstream = requestFor(target)({ ...options, method: "GET" });
  if (pin) pinRequest(upstream, pin);
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(raw101(upRes));
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    // Gniazdo przejęte przy upgradzie jest ODCZEPIONE od serwera: nie widzi go
    // ani `closeAllConnections()`, ani `close()`, które przez to czeka na nie
    // w nieskończoność. Trzymamy je w rejestrze i zrywamy sami przy zamykaniu.
    live.add(socket);
    live.add(upSocket);
    const forget = () => {
      live.delete(socket);
      live.delete(upSocket);
    };
    const drop = () => {
      forget();
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on("error", drop);
    socket.on("error", drop);
    upSocket.on("close", () => {
      forget();
      socket.destroy();
    });
    socket.on("close", () => {
      forget();
      upSocket.destroy();
    });
  });
  // Host odpowiedział zwykłym HTTP (401 z bramki auth, 404) — oddajemy status
  // klientowi, zamiast zostawiać go w ciszy na wiszącym upgradzie.
  upstream.on("response", (upRes) => bail(socket, upRes.statusCode ?? 502, "Upgrade Failed"));
  upstream.on("error", () => bail(socket, 502, "Bad Gateway"));
  if (head?.length) upstream.write(head);
  upstream.end();
}

async function listenOnStablePort(server) {
  for (let port = PORT_FIRST; port <= PORT_LAST; port += 1) {
    const taken = await new Promise((done) => {
      const onError = () => {
        server.removeListener("listening", onListening);
        done(true);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        done(false);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (!taken) return port;
  }
  return null;
}

/**
 * Podnosi lokalny origin dla jednego hosta. Zwraca `null`, gdy się nie da —
 * wtedy `main.mjs` wraca do ładowania interfejsu prosto z hosta, czyli do
 * zachowania sprzed tej zmiany. Brak tego serwera ma degradować apkę do
 * poprzedniego trybu, nigdy do białego ekranu.
 */
export async function startRemoteUiServer({ staticDir, remoteUrl, pin }) {
  if (!staticDir || !existsSync(join(staticDir, "index.html"))) return null;
  const root = resolve(staticDir);
  // Gniazda WebSocketa przejęte przy upgradzie — patrz komentarz w `pipeWs`.
  const live = new Set();
  const server = createServer((req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const file = req.method === "GET" || req.method === "HEAD" ? staticFileFor(root, pathname) : null;
      if (file) serveStatic(res, file, req.method);
      else proxyHttp(req, res, remoteUrl, pin);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  server.on("upgrade", (req, socket, head) => pipeWs(req, socket, head, remoteUrl, live, pin));
  server.on("clientError", (_err, socket) => socket.destroy());
  const port = await listenOnStablePort(server);
  if (port == null) {
    server.close();
    return null;
  }
  return {
    url: `http://127.0.0.1:${port}`,
    remoteUrl,
    // `closeAllConnections` obowiązkowo: po przełączeniu hosta wiszą jeszcze
    // gniazda WebSocketa i połączenia keep-alive do POPRZEDNIEGO adresu. Samo
    // `close()` czeka, aż same się skończą, więc port nie zwolniłby się nigdy,
    // a kolejny host dostałby inny numer — czyli inny origin i wyczyszczone
    // ustawienia interfejsu.
    close: () =>
      new Promise((done) => {
        for (const socket of live) socket.destroy();
        live.clear();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
