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
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { extname, join, resolve, sep } from "node:path";

import { isOnionHost } from "./host-resolve.mjs";
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
 *
 * Razem z flagą jedzie ADRES hosta. Bez niego ekran logowania w trybie zdalnym
 * pokazywał origin proxy (`http://127.0.0.1:47820`) jako „adres serwera" i nie
 * miał czym wypełnić formularza, więc onboarding zaczynał od pytania „postawić
 * serwer czy zalogować się", choć host jest już wybrany. Adres nie jest
 * tajemnicą — ta strona i tak w całości jedzie z tego serwera.
 */
function remoteFlag(remoteUrl) {
  // `<` uciekamy sami: adres wpisuje użytkownik, a `</script>` w nim zamknęłoby
  // ten blok i wszystko dalej byłoby już zwykłym HTML-em.
  const literal = JSON.stringify(String(remoteUrl)).replace(/</g, "\\u003c");
  return `<script>window.__MULTIBOT_REMOTE__=true;window.__MULTIBOT_HOST__=${literal}</script>`;
}

function serveStatic(res, file, method, remoteUrl) {
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
    // Podmiana FUNKCJĄ, nie łańcuchem: w łańcuchu zastępującym `$&`, ``$` ``,
    // `$'` i `$$` są wzorcami, które `replace` rozwija PO naszym uciekaniu —
    // adres z ``$` `` wklejałby w dokument wszystko, co stoi przed `</head>`.
    const body = Buffer.from(readFileSync(file, "utf8").replace("</head>", () => remoteFlag(remoteUrl) + "</head>"));
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
function upstreamOptions(req, remote, { keepHandshake = false, agent } = {}) {
  const target = new URL(req.url ?? "/", remote);
  const headers = { ...req.headers, host: target.host };
  if (!keepHandshake) for (const name of HOP_BY_HOP) delete headers[name];
  return {
    target,
    options: {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      protocol: target.protocol,
      path: target.pathname + target.search,
      headers,
      // Hosty 0.4.0 mają certyfikat z własnego podpisu, więc łańcucha nie ma
      // czym sprawdzić; zaufanie stoi na odcisku przypiętym w `pin`
      // (electron/tls-pin.mjs) — bez niego byłoby to gołe „ufam każdemu".
      rejectUnauthorized: false,
      // Pula tego jednego hosta, BEZ wznawiania sesji (`maxCachedSessions: 0`):
      // każde nowe gniazdo robi pełny uścisk dłoni, więc przypięcie odpala się
      // za każdym razem, a nie tylko przy pierwszym połączeniu w sesji. Gniazdo
      // już sprawdzone wolno używać dalej — to wciąż ten sam, zweryfikowany
      // peer. Pula ginie razem z proxy, więc następny host zaczyna od zera.
      agent: target.protocol === "https:" ? agent : undefined,
    },
  };
}

function proxyHttp(req, res, remote, pin, agent) {
  const { target, options } = upstreamOptions(req, remote, { agent });
  const upstream = requestFor(target)(options, (up) => {
    const headers = { ...up.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    // Jedyny HTML, który to okno ma prawo wyrenderować, to `index.html` z
    // PACZKI. Strona przysłana przez hosta pod byle ścieżką dostałaby origin
    // 127.0.0.1 — czyli most `window.ogb` i wszystko, co za nim stoi.
    if (!target.pathname.startsWith("/api") && /^text\/html/i.test(String(headers["content-type"] ?? ""))) {
      up.resume();
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "host tried to serve HTML outside /api" }));
      return;
    }
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
function pipeWs(req, socket, head, remote, live, pin, agent) {
  const { target, options } = upstreamOptions(req, remote, { keepHandshake: true, agent });
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
  upstream.on("error", (err) => bail(socket, 502, err.code === CERT_CHANGED ? "Server Certificate Changed" : "Bad Gateway"));
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
export async function startRemoteUiServer({ staticDir, remoteUrl, pin, createConnection = null }) {
  // Adres sprawdzamy BEZWARUNKOWO i jako pierwszy. Wcześniej `new URL(…)`
  // stało za `!pin &&`, więc z przypięciem w ręku nikt go nie oglądał i
  // `undefined` jechało dalej — aż do `window.__MULTIBOT_HOST__="undefined"`
  // w oknie, czyli ekranu logowania do serwera o nazwie „undefined".
  const target = new URL(remoteUrl);
  // Fail closed: `rejectUnauthorized:false` bez przypięcia to zaufanie
  // czemukolwiek, co odpowie. Wolimy nie wstać (main.mjs degraduje wtedy do
  // ładowania prosto z hosta, gdzie certyfikat pilnuje `setCertificateVerifyProc`)
  // niż cicho proksować przez nieznajomego.
  if (!pin && target.protocol === "https:") {
    throw new Error("remote UI proxy for an https host requires a certificate pin");
  }
  // Adres .onion BEZ tunelu byłby zwykłym `net.connect`, czyli zapytaniem DNS
  // o nazwę usługi ukrytej — wyciekiem, i to do adresu, którego i tak nie da
  // się rozwiązać. Fail closed; main.mjs pokazuje wtedy HOST_ERROR_PAGE
  // zamiast ładować hosta wprost.
  if (isOnionHost(target.hostname) && (target.protocol !== "https:" || !createConnection)) {
    throw new Error("an .onion host needs https and a Tor connector");
  }
  if (!staticDir || !existsSync(join(staticDir, "index.html"))) return null;
  const root = resolve(staticDir);
  const agent = new HttpsAgent({ keepAlive: true, maxCachedSessions: 0 });
  // Jedno miejsce na CAŁY ruch do hosta: `proxyHttp` i `pipeWs` idą tym samym
  // agentem, więc podmiana jego `createConnection` przenosi przez tor także
  // WebSocket. Podmiana jest tu, a nie w opcjach żądania, bo tylko agent
  // przeżywa między żądaniami razem z pulą gniazd.
  if (createConnection) agent.createConnection = createConnection;
  // Gniazda WebSocketa przejęte przy upgradzie — patrz komentarz w `pipeWs`.
  const live = new Set();
  const server = createServer((req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const file = req.method === "GET" || req.method === "HEAD" ? staticFileFor(root, pathname) : null;
      if (file) serveStatic(res, file, req.method, remoteUrl);
      else proxyHttp(req, res, remoteUrl, pin, agent);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  server.on("upgrade", (req, socket, head) => pipeWs(req, socket, head, remoteUrl, live, pin, agent));
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
        agent.destroy();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
