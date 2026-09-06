// Pure host-resolution logic for the Electron shell (C2). Deliberately free
// of Electron/fs/safeStorage imports so it runs under plain `node` in the
// self-check (host-resolve.test.mjs) without a packaged app context.

/** @typedef {{ id: string, name: string, url: string, tokenEnc: string, tlsFingerprint?: string, createdAt: number }} RemoteHost */
/** @typedef {{ activeId: string, hosts: RemoteHost[] }} HostsConfig */

/** Adres z wbudowanym loginem to nie jest adres serwera: poświadczenia z URL-a
 * jadą potem w każdym żądaniu i zostają w zapisanym rekordzie hosta. */
function checkedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Host address must start with http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Host address must not carry a username or password");
  }
  return url;
}

/** Strips trailing slashes and rejects anything that isn't http(s).
 * `assumeHttps` fills the scheme in for a bare `address:port` — that is how the
 * server's three values get retyped on a second device, and servers from 0.4.0
 * listen on HTTPS only. Off by default, bo stara droga („Połącz" w onboardingu)
 * dodaje dziś także serwery po gołym HTTP i zapisałaby wtedy martwy adres. */
export function normalizeRemoteUrl(raw, { assumeHttps = false } = {}) {
  const trimmed = String(raw ?? "")
    .trim()
    .replace(/\/+$/, "");
  const bare = /^(.+):(\d{1,5})$/.exec(trimmed);
  const port = bare ? Number(bare[2]) : 0;
  if (assumeHttps && port >= 1 && port <= 65535 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return checkedUrl(`https://${trimmed}`);
  }
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    throw new Error("Host address must start with http:// or https://");
  }
  return checkedUrl(trimmed);
}

/** Ten sam serwer wpisany jako `https://h:8799/` i `https://h:8799` to jeden
 * host — i tak samo ten sam adres wracający z błędu certyfikatu. */
export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Jeden rekord na serwer. Nowy wpis zastępuje WSZYSTKIE o tym samym originie i
 * przejmuje po nich to, czego sam nie przyniósł: id (żeby `activeId` nie zawisło
 * w próżni), token i przypięty odcisk — inaczej ponowne logowanie zgubiłoby
 * przypięcie i zaufałoby pierwszemu napotkanemu certyfikatowi. */
export function mergeRemoteHost(hosts, host) {
  const base = hosts.find((h) => sameOrigin(h.url, host.url));
  const merged = {
    ...host,
    id: base?.id ?? host.id,
    name: host.name || base?.name || host.url,
    tokenEnc: host.tokenEnc ?? base?.tokenEnc,
    tlsFingerprint: host.tlsFingerprint || base?.tlsFingerprint || undefined,
    createdAt: base?.createdAt ?? host.createdAt,
  };
  return [merged, ...hosts.filter((h) => !sameOrigin(h.url, host.url))];
}

/** Czy oba adresy wskazują ten sam DOKUMENT, czyli różnią się najwyżej
 * fragmentem. Ponowne wejście na tego samego hosta zmienia w adresie tylko
 * `#join=<grant>`, a taka nawigacja NIE przeładowuje strony — grant nigdy nie
 * zostaje odczytany. Pusty adres (świeże okno) to nie jest ten sam dokument. */
export function sameDocument(a, b) {
  return Boolean(a) && String(a).split("#")[0] === String(b).split("#")[0];
}

export function removeRemoteHost(hosts, id) {
  return hosts.filter((h) => h.id !== id);
}

/** Given the persisted config, decides what main.mjs should load: "local"
 * (today's default, unchanged) or a specific remote host record. Any
 * dangling activeId (host removed, corrupt config) falls back to local
 * rather than erroring — never brick the app on a bad hosts.json. */
export function resolveActiveTarget(config) {
  if (!config || !config.activeId || config.activeId === "local") return { mode: "local" };
  const host = (config.hosts ?? []).find((h) => h.id === config.activeId);
  if (!host) return { mode: "local" };
  return { mode: "remote", host };
}

/** Czy zapakowana apka ma w ogóle podnieść lokalny harness. Aktywny host
 * zdalny znaczy „ten komputer jest tylko klientem" — forkowanie serwera
 * tworzyłoby wtedy ~/.openmausbot (server/config.ts) i wrzucało użytkownika
 * na ekran zakładania serwera, którego nie chciał. W trybie dev harness i tak
 * nie wstaje z Electrona, więc `isPackaged=false` zawsze daje false. */
export function shouldStartLocalHarness({ isPackaged, mode }) {
  return isPackaged === true && mode !== "remote";
}
