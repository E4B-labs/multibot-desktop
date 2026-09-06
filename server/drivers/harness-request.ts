// multibot: żądanie z proxy MCP do harnessu, BEZ limitu czasu.
//
// Globalny `fetch` Node'a (undici) ma domyślny `headersTimeout` 300 s. Trasy
// wewnętrzne harnessu celowo trzymają połączenie znacznie dłużej: ask-bot
// czeka na turę bota do 20 minut, a ask_user na odpowiedź człowieka bez
// żadnego sufitu. Po pięciu minutach undici zrywał połączenie i wołający bot
// dostawał `TypeError: fetch failed` — dla użytkownika "błąd sieciowy", a bot
// docelowy nie odpowiadał wcale, choć swoją turę robił dalej.
//
// `node:http` nie nakłada żadnego limitu na czas oczekiwania na nagłówki,
// więc zamiast fetch idzie tu surowy request. Ruch jest wyłącznie po
// loopbacku, ale protokół bierzemy z adresu, żeby https też przeszło.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** `URL.hostname` oddaje IPv6 bez nawiasów, stąd goły `::1`. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface HarnessResponse {
  status: number;
  body: string;
}

export interface HarnessRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

type RequestImpl = typeof httpRequest;

export function harnessRequest(
  url: string,
  init: HarnessRequestInit = {},
  requestImpl?: RequestImpl,
): Promise<HarnessResponse> {
  const target = new URL(url);
  const impl = requestImpl ?? (target.protocol === "https:" ? (httpsRequest as RequestImpl) : httpRequest);
  const options: import("node:https").RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: init.method ?? "GET",
    headers: init.headers,
    // Harness od 0.4.0 ma certyfikat z WŁASNYM podpisem (server/tls-cert.ts), a
    // to wywołanie idzie po pętli zwrotnej z procesu, którego harness sam
    // uruchomił — łańcucha nie ma czym sprawdzić i nie ma po co. Poświadczeniem
    // jest OMB_COMMS_TOKEN, nie certyfikat. Poza pętlą zwrotną łańcuch
    // sprawdzamy normalnie: tam „ufam każdemu" byłoby dziurą, nie wygodą.
    // ponytail: bez przypięcia na loopbacku; sufit = ktoś, kto już przejął
    // pętlę zwrotną tej maszyny — wtedy i tak jest po wszystkim.
    rejectUnauthorized: !LOOPBACK.has(target.hostname.toLowerCase()),
    // celowo BEZ `timeout` — patrz nagłówek pliku
  };
  return new Promise((resolve, reject) => {
    const req = impl(
      options,
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
