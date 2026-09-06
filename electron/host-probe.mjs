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

/** `GET /api/public/server` → probe result. A MultiBot server is the one that
 * answers with a serverId; anything else on that port belongs to somebody
 * else. `configured` says whether the server already has its own name and
 * password (legacy builds called it `setupDone`). */
export function classifyProbe(status, body) {
  if (status !== 200 || typeof body?.serverId !== "string" || !body.serverId) return { ok: false, error: "not-multibot" };
  return { ok: true, configured: Boolean(body.configured ?? body.setupDone) };
}

/** `POST /api/auth/join` → join result. Server error codes
 * (`wrong_server_name`, `wrong_server_password`, `server_not_set_up`, …) pass
 * through untouched: the sign-in form maps them to the field at fault. */
export function classifyJoin(status, body) {
  if (status === 200 && typeof body?.joinGrant === "string") {
    return { ok: true, joinGrant: body.joinGrant, expiresAt: body.expiresAt, hasUsers: body.hasUsers };
  }
  if (typeof body?.error === "string") return { ok: false, error: body.error };
  // No route, no error code: an old server, or not one of ours at all.
  return { ok: false, error: status === 404 ? "not-multibot" : `http_${status}` };
}

function requestJson(url, { method = "GET", body, pin, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((done, fail) => {
    const target = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {},
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
          if (raw.length < MAX_BODY) raw += chunk;
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
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timed out"), { code: TIMED_OUT })));
    req.on("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
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

/** Exchanges the server name + password for a short-lived join grant. Neither
 * the password nor the grant is ever logged. */
export async function joinServer(url, { serverName, serverPassword, ...options } = {}) {
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
