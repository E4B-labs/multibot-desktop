// Pure host-resolution logic for the Electron shell (C2). Deliberately free
// of Electron/fs/safeStorage imports so it runs under plain `node` in the
// self-check (host-resolve.test.mjs) without a packaged app context.

/** @typedef {{ id: string, name: string, url: string, tokenEnc: string, tlsFingerprint?: string, createdAt: number }} RemoteHost */
/** @typedef {{ activeId: string, hosts: RemoteHost[] }} HostsConfig */

/** Strips trailing slashes and rejects anything that isn't http(s). A pasted
 * address usually arrives bare — `192.168.1.42:8799`, `[2a00:…]:8799` — and
 * 0.4.0 servers listen on HTTPS only, so that is the scheme filled in for it.
 * Anything else without a scheme stays an error instead of a guess. */
export function normalizeRemoteUrl(raw) {
  const trimmed = String(raw ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (/^(?:[\w.-]+|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(trimmed)) return `https://${trimmed}`;
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    throw new Error("Host address must start with http:// or https://");
  }
  return trimmed;
}

/** Adds or replaces a host by id, newest first. */
export function upsertRemoteHost(hosts, host) {
  return [host, ...hosts.filter((h) => h.id !== host.id)];
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
