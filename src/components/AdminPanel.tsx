// Owner-only view of the server itself: who is on it, what it is doing, and
// the two credentials other devices need. Every card renders only when the
// server actually sent its data — the address, GPU and TLS fields arrive with
// their own PRs, and a placeholder that says "—" forever is worse than no card.
import { useEffect, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { copyText } from "@/lib/shell";
import { MachineResources } from "./AppSettingsPanel";
import { addressNote } from "./Onboarding";

/** One poll for the whole tab. Ten seconds is slow enough to be free on a
 * phone-hosted server and fast enough that "who is online" is not a lie. */
export const ADMIN_POLL_MS = 10000;

/** Same rule as `isServerName` in server/identity.ts. Duplicated rather than
 * imported: that module pulls in node:sqlite and has no business in the bundle. */
export function isServerName(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$/.test(value);
}

export type AdminUser = {
  id: string;
  name?: string;
  username?: string;
  email?: string | null;
  role?: string;
  createdAt?: number;
  lastSeenAt?: number;
  messages?: number;
  botsOwned?: number;
  disabled?: boolean;
};

export type AdminOverview = {
  users?: AdminUser[];
  server?: {
    gpu?: string | null;
    tlsFingerprint?: string | null;
    uptimeMs?: number;
    version?: string;
    connectionsActive?: number;
  };
  bots?: { total?: number; busy?: number; byVisibility?: { public?: number; team?: number; private?: number } };
  // Bez `tokens24h`: `workspace` trzyma sumy per bot od zawsze, a drugi ring
  // tylko po to jedno nie ma za co istnieć (server/admin.ts).
  performance?: { avgResponseMs?: number; p95ResponseMs?: number; turns24h?: number; errorRate?: number };
};

/** The shape `GET/POST /api/server/address` guarantees (server/net-address.ts).
 * Not optional field by field any more: the route exists, so a missing report
 * means the call itself failed — one `null`, not five maybes. */
type AddressReport = {
  current: string | null;
  verified: boolean;
  checkedAt: number;
  candidates: Array<{ address: string; kind: string; verified: boolean }>;
  portMapping: { state: string };
};

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/** "3 minutes ago" in whichever language the app is in. Timestamps straight
 * from the database mean nothing to the person reading the table. */
export function relativeTime(at: number | undefined | null, now: number, locale: string): string {
  if (!at) return "—";
  const delta = at - now;
  const absolute = Math.abs(delta);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of UNITS) if (absolute >= ms) return format.format(Math.round(delta / ms), unit);
  return format.format(0, "second");
}

export function uptimeText(ms: number | undefined, polish: boolean): string {
  if (!ms || ms < 0) return "—";
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return polish ? `${days} d ${hours % 24} h` : `${days}d ${hours % 24}h`;
  const minutes = Math.floor(ms / 60_000) % 60;
  return polish ? `${hours} h ${minutes} min` : `${hours}h ${minutes}m`;
}

const ERROR_TEXTS: Record<string, [string, string]> = {
  "owner access required": ["Only the server owner can do that.", "Może to zrobić tylko właściciel serwera."],
  "invalid server name": ["Server name: 3-32 characters, lowercase letters, digits and dashes (not at either end).", "Nazwa serwera: 3-32 znaki, małe litery, cyfry i myślniki (nie na początku ani na końcu)."],
  last_owner: ["This is the last owner — demoting or disabling them would lock everyone out.", "To ostatni właściciel — degradacja albo wyłączenie zamknęłoby dostęp wszystkim."],
  no_such_profile: ["That profile no longer exists on this server.", "Tego profilu już nie ma na tym serwerze."],
  "cannot reset another owner": ["An owner's password is theirs alone — only they can recover it, with their own code.", "Hasło właściciela należy tylko do niego — odzyskuje je sam, własnym kodem."],
  "invalid role": ["A profile is either an owner or a member.", "Profil jest właścicielem albo członkiem."],
  "too many attempts": ["Too many attempts. Wait a minute and try again.", "Za dużo prób. Odczekaj minutę i spróbuj ponownie."],
  not_found: ["The server does not have that yet.", "Serwer jeszcze tego nie ma."],
};

/** Raw server codes on an admin screen are a dead end: they name the check that
 * failed, never what to do about it. */
export function adminErrorText(code: string, polish: boolean): string {
  const pair = ERROR_TEXTS[code];
  if (pair) return polish ? pair[1] : pair[0];
  return polish ? `Serwer odmówił: ${code}` : `The server refused: ${code}`;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{title}</div>
      {children}
    </div>
  );
}

/** Shown once, unreadable afterwards — so it stays until it is dismissed by
 * hand. A modal browser dialog lost it to a stray Enter key and left nothing
 * to select or copy. */
function SecretBox({ secret, polish, onDismiss }: { secret: { kind: "serverPassword" | "recoveryCode"; value: string; who?: string }; polish: boolean; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const password = secret.kind === "serverPassword";
  return (
    <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">
      <div>
        {password
          ? polish ? "Nowe hasło serwera — pokazujemy je tylko raz:" : "New server password — shown only once:"
          : polish ? `Kod odzyskiwania dla ${secret.who ?? "profilu"} — pokazujemy go tylko raz:` : `Recovery code for ${secret.who ?? "that profile"} — shown only once:`}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all text-[13px] text-ink">{secret.value}</code>
        <button type="button" title={polish ? "Kopiuj" : "Copy"} aria-label={polish ? "Kopiuj" : "Copy"} onClick={() => void copyText(secret.value).then(setCopied)} className="shrink-0 text-ink-secondary hover:text-ink"><Copy size={12} /></button>
      </div>
      <div className="mt-1">
        {password
          ? polish ? "Stare hasło już nie działa — urządzenia dołączają nowym." : "The old password no longer works; devices join with this one."
          : polish ? "Przekaż go tej osobie. Ustawi nim nowe hasło profilu." : "Hand it to that person. They set a new profile password with it."}
      </div>
      <button type="button" onClick={onDismiss} className="mt-2 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover">
        {copied ? (polish ? "Skopiowane — ukryj" : "Copied — hide") : polish ? "Zapisałem — ukryj" : "I saved it — hide"}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-baseline justify-between gap-3 text-[12.5px] text-ink-secondary">
      <span>{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-ink">{value}</span>
    </div>
  );
}

export function AdminPanel() {
  const language = useLanguage();
  const polish = language === "pl";
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [server, setServer] = useState<{ name?: string; publicAddress?: string; addressVerified?: boolean; tlsFingerprint?: string } | null>(null);
  const [addresses, setAddresses] = useState<AddressReport | null>(null);
  // Pokazywane RAZ i nie do odczytania ponownie: hasło serwera po rotacji i kod
  // odzyskiwania po resecie. Zostają na ekranie, dopóki ktoś sam ich nie zamknie
  // — okienko, które znika samo, gubi poświadczenie bez śladu.
  const [secret, setSecret] = useState<{ kind: "serverPassword" | "recoveryCode"; value: string; who?: string } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () => authFetch("/api/admin/overview")
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (!alive || !value) return;
        setOverview(value as AdminOverview);
        setNow(Date.now());
      })
      .catch(() => {});
    load();
    const timer = setInterval(load, ADMIN_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // Read once: the server's own record and the address report change when
  // somebody changes them, not on a timer.
  useEffect(() => {
    let alive = true;
    void authFetch("/api/server").then((response) => response.ok && response.json()).then((value) => { if (!alive || !value) return; setServer(value); setName(value.name ?? ""); }).catch(() => {});
    void authFetch("/api/server/address").then((response) => response.ok && response.json()).then((value) => alive && value && setAddresses(value as AddressReport)).catch(() => {});
    return () => { alive = false; };
  }, []);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch(path, { method: "POST", body: JSON.stringify(body) });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error ?? `${response.status}`);
      return value;
    } catch (reason) {
      setError(adminErrorText(reason instanceof Error ? reason.message : String(reason), polish));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const renameServer = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch("/api/server", { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error ?? `${response.status}`);
      setServer((current) => ({ ...current, ...value }));
    } catch (reason) {
      setError(adminErrorText(reason instanceof Error ? reason.message : String(reason), polish));
    } finally {
      setBusy(false);
    }
  };

  const patchUser = async (id: string, change: { role?: string; disabled?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(change) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `${response.status}`);
      setOverview((current) => current && { ...current, users: current.users?.map((user) => (user.id === id ? { ...user, ...change } : user)) });
    } catch (reason) {
      setError(adminErrorText(reason instanceof Error ? reason.message : String(reason), polish));
    } finally {
      setBusy(false);
    }
  };

  // `/api/server` already resolves "the address we publish" (the report first,
  // then the stored one), so it is the single source; the report only fills in
  // while that call is still in flight.
  const address = server?.publicAddress ?? addresses?.current ?? null;
  const note = addressNote(address ? {
    serverName: "",
    serverPassword: "",
    address,
    addressVerified: server?.addressVerified ?? addresses?.verified,
    addressKind: addresses?.candidates.find((candidate) => candidate.address === address)?.kind,
    portMapping: addresses?.portMapping,
  } : null, polish);
  const fingerprint = server?.tlsFingerprint ?? overview?.server?.tlsFingerprint ?? null;
  const users = overview?.users ?? [];
  const bots = overview?.bots;
  const performance = overview?.performance;

  if (!overview && !server) {
    return <div className="mt-6 flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={16} className="animate-spin" />{polish ? "Wczytywanie…" : "Loading…"}</div>;
  }

  return (
    <>
      {(server?.name || address || overview?.server?.version) && (
        <Card title={polish ? "Serwer" : "Server"}>
          {server?.name !== undefined && (
            <div className="mt-3 flex gap-2">
              {/* The name is one of the three values somebody types into another
                  device, so it has to stay a slug — the rule the server enforces. */}
              <input value={name} onChange={(event) => setName(event.target.value)} aria-label={polish ? "Nazwa serwera" : "Server name"} placeholder="brave-otter" className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-hairline" />
              <button type="button" disabled={busy || !isServerName(name.trim()) || name.trim() === server.name} onClick={() => void renameServer()} className="shrink-0 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">{polish ? "Zapisz nazwę" : "Save name"}</button>
            </div>
          )}
          {overview?.server?.version && <Row label={polish ? "Wersja" : "Version"} value={overview.server.version} />}
          {overview?.server?.uptimeMs !== undefined && <Row label={polish ? "Czas pracy" : "Uptime"} value={uptimeText(overview.server.uptimeMs, polish)} />}
          {overview?.server?.connectionsActive !== undefined && <Row label={polish ? "Połączenia" : "Connections"} value={overview.server.connectionsActive} />}
          {address && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
              <code className="min-w-0 flex-1 select-all break-all text-[12.5px] text-ink">{address}</code>
              <button type="button" title={polish ? "Kopiuj" : "Copy"} aria-label={polish ? "Kopiuj adres" : "Copy address"} onClick={() => void copyText(address)} className="shrink-0 text-ink-secondary hover:text-ink"><Copy size={13} /></button>
            </div>
          )}
          {note && <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{note}</div>}
          {fingerprint && (
            <div className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
              {polish ? "Odcisk certyfikatu:" : "Certificate fingerprint:"} <code className="select-all break-all text-ink">{fingerprint}</code>
            </div>
          )}
          {addresses && addresses.candidates.length > 0 && (
            <div className="mt-3">
              <div className="text-[12px] text-ink-secondary">{polish ? "Inne adresy" : "Other addresses"}</div>
              {addresses.candidates.map((candidate) => (
                <div key={candidate.address} className="mt-1 flex items-center gap-2 text-[12px]">
                  <code className="min-w-0 flex-1 truncate text-ink">{candidate.address}</code>
                  <span className="shrink-0 text-ink-secondary">{candidate.kind}</span>
                  <button type="button" disabled={busy} onClick={() => void post("/api/server/address", { address: candidate.address }).then((value) => value && setAddresses(value as AddressReport))} className="shrink-0 text-ink-secondary hover:text-ink disabled:opacity-50">{polish ? "Przypnij" : "Pin"}</button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void post("/api/server/address", { refresh: true }).then((value) => value && setAddresses(value as AddressReport))} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">{polish ? "Odśwież adres" : "Refresh address"}</button>
            <button type="button" disabled={busy} onClick={() => { if (!window.confirm(polish ? "Wygenerować nowe hasło serwera? Stare przestanie działać i każde urządzenie będzie musiało dołączyć nowym." : "Generate a new server password? The old one stops working and every device has to join with the new one.")) return; void post("/api/server/password", {}).then((value) => value && setSecret({ kind: "serverPassword", value: String(value.serverPassword ?? "") })); }} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">{polish ? "Nowe hasło serwera" : "New server password"}</button>
          </div>
          {secret?.kind === "serverPassword" && <SecretBox secret={secret} polish={polish} onDismiss={() => setSecret(null)} />}
        </Card>
      )}

      <MachineResources />
      {overview?.server?.gpu && (
        <div className="mt-2 rounded-xl bg-card px-4 py-3 text-[12.5px] text-ink-secondary">GPU <b className="font-medium text-ink">{overview.server.gpu}</b></div>
      )}

      {users.length > 0 && (
        <Card title={polish ? "Użytkownicy" : "Users"}>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-ink-secondary">
                <tr>
                  <th className="pb-1 font-normal">{polish ? "Nazwa" : "Name"}</th>
                  {users.some((user) => user.email) && <th className="pb-1 font-normal">Email</th>}
                  <th className="pb-1 font-normal">{polish ? "Ostatnio" : "Last seen"}</th>
                  <th className="pb-1 text-right font-normal">{polish ? "Wiadomości" : "Messages"}</th>
                  <th className="pb-1 font-normal">{polish ? "Rola" : "Role"}</th>
                  <th className="pb-1" />
                </tr>
              </thead>
              <tbody className="text-ink">
                {users.map((user) => (
                  <tr key={user.id} className={user.disabled ? "opacity-50" : undefined}>
                    <td className="py-1 pr-2">{user.name || user.username}</td>
                    {users.some((other) => other.email) && <td className="py-1 pr-2 text-ink-secondary">{user.email ?? "—"}</td>}
                    <td className="py-1 pr-2 text-ink-secondary">{relativeTime(user.lastSeenAt, now, language)}</td>
                    <td className="py-1 pr-2 text-right">{user.messages ?? 0}</td>
                    <td className="py-1 pr-2 text-ink-secondary">{user.role}</td>
                    <td className="py-1 text-right">
                      <button type="button" disabled={busy} onClick={() => { const who = user.name || user.username || user.id; if (!window.confirm(polish ? `Zresetować hasło profilu ${who}? Dostaniesz jednorazowy kod, który trzeba mu przekazać.` : `Reset the profile password for ${who}? You get a one-time code to hand over.`)) return; void post(`/api/admin/users/${encodeURIComponent(user.id)}/reset`, {}).then((value) => value?.recoveryCode && setSecret({ kind: "recoveryCode", value: String(value.recoveryCode), who })); }} className="text-ink-secondary hover:text-ink disabled:opacity-50">Reset</button>
                      <button type="button" disabled={busy} onClick={() => { const who = user.name || user.username || user.id; if (!window.confirm(user.disabled ? (polish ? `Włączyć profil ${who} z powrotem?` : `Enable ${who} again?`) : polish ? `Wyłączyć profil ${who}? Nie zaloguje się, dopóki go nie włączysz.` : `Disable ${who}? They cannot sign in until you enable them again.`)) return; void patchUser(user.id, { disabled: !user.disabled }); }} className="ml-3 text-ink-secondary hover:text-danger disabled:opacity-50">{user.disabled ? (polish ? "Włącz" : "Enable") : polish ? "Wyłącz" : "Disable"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {secret?.kind === "recoveryCode" && <SecretBox secret={secret} polish={polish} onDismiss={() => setSecret(null)} />}
        </Card>
      )}

      {bots && (
        <Card title={polish ? "Boty" : "Bots"}>
          <Row label={polish ? "Wszystkie" : "Total"} value={bots.total ?? 0} />
          <Row label={polish ? "Pracują" : "Busy"} value={bots.busy ?? 0} />
          {bots.byVisibility && <Row label={polish ? "Widoczność" : "Visibility"} value={polish
            ? `${bots.byVisibility.public ?? 0} publiczne · ${bots.byVisibility.team ?? 0} zespołowe · ${bots.byVisibility.private ?? 0} prywatne`
            : `${bots.byVisibility.public ?? 0} public · ${bots.byVisibility.team ?? 0} team · ${bots.byVisibility.private ?? 0} private`} />}
        </Card>
      )}

      {performance && (
        <Card title={polish ? "Wydajność" : "Performance"}>
          {performance.avgResponseMs !== undefined && <Row label={polish ? "Średni czas odpowiedzi" : "Average response"} value={`${Math.round(performance.avgResponseMs / 100) / 10} s`} />}
          {performance.p95ResponseMs !== undefined && <Row label="p95" value={`${Math.round(performance.p95ResponseMs / 100) / 10} s`} />}
          {performance.turns24h !== undefined && <Row label={polish ? "Tury (24 h)" : "Turns (24h)"} value={performance.turns24h} />}
          {performance.errorRate !== undefined && <Row label={polish ? "Błędy" : "Errors"} value={`${Math.round(performance.errorRate * 1000) / 10}%`} />}
        </Card>
      )}

      {error && <div className="mt-3 text-[12px] text-danger">{error}</div>}
    </>
  );
}
