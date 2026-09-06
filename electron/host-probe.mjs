// Native calls to a MultiBot server, made by the Electron main process.
// Native and not a renderer `fetch` because the webui lives in the server's
// own origin: the address has to be resolved and the server credentials
// exchanged BEFORE that origin is loaded, and the server sends no CORS
// headers. Free of Electron imports so it runs under plain vitest.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { CERT_CHANGED, pinRequest } from "./tls-pin.mjs";

const TIMEOUT_MS = 8000;
const TIMED_OUT = "MULTIBOT_TIMEOUT";
const MAX_BODY = 64 * 1024;

/** Transport failure → the code the sign-in form shows on the address field. */
export function failureCode(err) {
  if (err?.code === TIMED_OUT) return "timeout";
  if (err?.code === CERT_CHANGED) return "certificate_changed";
  return "unreachable";
}

/** Kody, które serwer ma prawo nam podyktować. Reszta jego `error` to tekst z
 * sieci — nie przepuszczamy go do interfejsu, bo formularz pokazałby napastnikowi
 * dowolne zdanie w swoim własnym oknie. */
const SERVER_CODES = new Set(["wrong_server_name", "wrong_server_password", "server_not_set_up", "rate_limited"]);

/** 429 z serwera niesie zdanie („too many attempts"), nie kod. Bez tego
 * mapowania ekran logowania dostawał `not_multibot` i mówił, że pod adresem nie
 * ma MultiBota — akurat wtedy, gdy jest, tylko każe odczekać minutę. */
const SERVER_ALIASES = new Map([["too many attempts", "rate_limited"]]);

/** `GET /api/public/server` → probe result. A MultiBot server is the one that
 * answers with a serverId; anything else on that port belongs to somebody
 * else. `configured` says whether the server already has its own name and
 * password (legacy builds called it `setupDone`). */
export function classifyProbe(status, body) {
  if (status !== 200 || typeof body?.serverId !== "string" || !body.serverId) return { ok: false, error: "not_multibot" };
  return { ok: true, configured: Boolean(body.configured ?? body.setupDone) };
}

/** `POST /api/auth/join` → join result. Server error codes
 * (`wrong_server_name`, `wrong_server_password`, `server_not_set_up`, …) pass
 * through untouched: the sign-in form maps them to the field at fault. */
export function classifyJoin(status, body) {
  if (status === 200 && typeof body?.joinGrant === "string") {
    return { ok: true, joinGrant: body.joinGrant, expiresAt: body.expiresAt, hasUsers: body.hasUsers };
  }
  const alias = SERVER_ALIASES.get(body?.error);
  if (alias) return { ok: false, error: alias };
  if (SERVER_CODES.has(body?.error)) return { ok: false, error: body.error };
  // Nieznany kod, brak kodu, nie-JSON, brakująca trasa: z punktu widzenia
  // ekranu logowania to jedno i to samo — pod tym adresem nie ma serwera,
  // do którego umiemy się zalogować.
  return { ok: false, error: "not_multibot" };
}

function requestJson(url, { method = "GET", body, pin, headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolveWith, rejectWith) => {
    const target = new URL(url);
    // Budżet CAŁEGO wywołania, nie samej bezczynności gniazda: serwer sączący
    // po bajcie utrzymywałby `setTimeout` na gnieździe w nieskończoność, a
    // ekran logowania obiecuje odpowiedź w 8 sekund.
    const budget = setTimeout(() => req.destroy(Object.assign(new Error("timed out"), { code: TIMED_OUT })), timeoutMs);
    const done = (value) => {
      clearTimeout(budget);
      resolveWith(value);
    };
    const fail = (err) => {
      clearTimeout(budget);
      rejectWith(err);
    };
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: payload ? { ...headers, "content-type": "application/json", "content-length": String(payload.length) } : { ...headers },
        // Self-signed is the norm here; trust rests on the pin, not on a CA.
        rejectUnauthorized: false,
        // Bez puli połączeń. MEASURED: pula (domyślna od node 19) oddaje
        // gotowe gniazdo bez nowego uścisku dłoni, więc przypięcie by się na
        // nim nie odpaliło. Te wywołania są dwa na całe logowanie, więc
        // świeże gniazdo nic nie kosztuje, a certyfikat jest sprawdzany
        // ZAWSZE — także wtedy, gdy hasło serwera idzie w tym żądaniu.
        agent: false,
      },
      (res) => {
        const tlsFingerprint = res.socket?.getPeerCertificate?.()?.fingerprint256;
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (raw.length < MAX_BODY) {
            raw += chunk;
            return;
          }
          // Zerwanie strumienia zabija też `end`, więc obietnicę trzeba
          // rozstrzygnąć TUTAJ — inaczej `hosts:probe` wisi w nieskończoność.
          // Treść odpadła, więc nie ma czego parsować: to nie jest odpowiedź
          // naszego serwera.
          done({ status: res.statusCode ?? 0, json: null, tlsFingerprint });
          res.destroy();
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* not JSON — the classifier calls that "not-multibot" */
          }
          done({ status: res.statusCode ?? 0, json, tlsFingerprint });
        });
      },
    );
    if (pin) pinRequest(req, pin);
    req.on("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Zwykły GET JSON-em, tym samym transportem co sondowanie: `fetch` w main
 * procesie nie przyjmie certyfikatu z własnego podpisu, a od 0.4.0 ma go także
 * LOKALNY harness (`/api/health`, `/api/config`).
 *
 * WYŁĄCZNIE pętla zwrotna: `requestJson` idzie z `rejectUnauthorized: false`, a
 * to wolno tylko wtedy, gdy drugi koniec jest na tej samej maszynie. Zdalny
 * host ma swoją drogę — `probeServer`/`joinServer` z przypięciem odcisku.
 * Błąd transportu i odmowa oddają `status: 0`, więc wołający ma jedno wyjście. */
export async function getJson(url, options = {}) {
  try {
    if (!isLoopbackHost(new URL(url))) return { status: 0, json: null };
    return await requestJson(url, options);
  } catch {
    return { status: 0, json: null };
  }
}

/** @returns {Promise<{ok:true,configured:boolean,tlsFingerprint?:string}|{ok:false,error:string}>} */
export async function probeServer(url, options = {}) {
  try {
    const { status, json, tlsFingerprint } = await requestJson(`${url}/api/public/server`, options);
    const result = classifyProbe(status, json);
    return result.ok ? { ...result, tlsFingerprint } : result;
  } catch (err) {
    return { ok: false, error: failureCode(err) };
  }
}

/** Czy adres wskazuje na TĘ maszynę. `URL.hostname` dla IPv6 bywa w nawiasach
 * albo bez, zależnie od zapisu — obie postacie liczą się tak samo. */
function isLoopbackHost(target) {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(target.hostname);
}

/** Pętla zwrotna to jedyne miejsce, gdzie gołe HTTP nie wynosi hasła poza
 * urządzenie (lokalny harness w trakcie przejścia na HTTPS). */
function isCleartextToTheWorld(target) {
  return target.protocol === "http:" && !isLoopbackHost(target);
}

/** Exchanges the server name + password for a short-lived join grant. Neither
 * the password nor the grant is ever logged. */

export async function joinServer(url, { serverName, serverPassword, ...options } = {}) {
  if (isCleartextToTheWorld(new URL(url))) return { ok: false, error: "insecure_address" };
  try {
    const { status, json, tlsFingerprint } = await requestJson(`${url}/api/auth/join`, {
      ...options,
      method: "POST",
      body: { serverName, serverPassword },
    });
    const result = classifyJoin(status, json);
    return result.ok ? { ...result, tlsFingerprint } : result;
  } catch (err) {
    return { ok: false, error: failureCode(err) };
  }
}
