// Connected apps marketplace, backed by Composio Connect. Catalog comes
// from /api/connectors/catalog — the full toolkit list with logos when a
// Composio API key is configured, a curated set otherwise.
//
// Ikony: najpierw znak z bundla (`@/lib/appIcons` po slugu), potem logo
// z katalogu Composio, na końcu monogram. Monogram NIE jest gałęzią else,
// tylko podkładem pod <img> — na telefonie interfejs jedzie z paczki
// aplikacji i żądanie na obcy host potrafi wisieć bez `onError`, a wtedy
// karta zostawała pusta zamiast pokazać literę.
// Znaki z bundla są PEŁNOKOLOROWE (cały <svg>, nie samo `d`) i renderują się
// własnymi barwami marki — patrz komentarz przy ServiceIcon.
// multibot (F7): ten sam katalog niesie też własne serwery MCP użytkownika
// (source === "custom") — renderowane w sekcji "MCP", obsługiwane trasami
// harnessa /api/connectors/custom/:id (działają bez klucza Composio).
//
// UKŁAD (0.5.28): jeden ekran w stylu Marketplace'u — lewa szyna kategorii,
// sekcje po kategoriach, „Zainstalowane" na górze. Duże okno TYLKO od `md:`;
// poniżej zostaje dokładnie ten kompaktowy panel co wcześniej
// (`w-full max-w-[640px]`, jedna kolumna), bo ten sam plik jedzie do repo
// mobilnego i telefon ma zostać bez zmian. Szyna jest `hidden md:flex`,
// a nad nią na wąskim ekranie jedzie przewijany pasek pigułek.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "./Loading";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { APP_ICONS } from "@/lib/appIcons";

interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  // multibot (F7): source mówi, którą trasą kartę odłączyć — Composio OAuth
  // vs DELETE /api/connectors/custom/:id.
  source?: "composio" | "custom";
  // multibot: kategoria z serwera (`server/composio.ts`), po niej lecą sekcje
  // i szyna. Brak = "other", bo katalog z API Composio bywa szerszy niż lista
  // kuratorowana.
  category?: string;
  // multibot: liczba narzędzi z ostatniego udanego testu własnego konektora
  tools?: number;
}
interface ConnectedAccount { id: string; alias?: string; status: string }

// Kafelek pod znakiem: JASNY w każdym motywie, nie `bg-raised` — `--color-raised`
// jest ciemne w motywach ciemnych, a wtedy czarne marki (GitHub, X, OpenAI,
// Vercel) znikają. Tak samo trzyma katalog Composio i Zapier.
const TILE =
  "grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-white p-1.5 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] [&>svg]:size-full";

function ServiceIcon({ card, className }: { card: ToolkitCard; className?: string }) {
  const [logoFailed, setLogoFailed] = useState(false);
  // `hasOwn`, a nie samo APP_ICONS[slug]: slug bywa z API Composio, nie tylko
  // z naszej listy, a toolkit nazwany „constructor" albo „toString" trafiłby
  // w prototyp. Zwrócona funkcja jest prawdziwa, więc przeszłaby `if (mark)`
  // i poniższy innerHTML wstrzyknąłby jej źródło zamiast logo.
  const mark = Object.hasOwn(APP_ICONS, card.slug) ? APP_ICONS[card.slug] : undefined;
  if (mark) {
    // Znak wjeżdża jako gotowy <svg> z własnymi kolorami marki, więc NIC tu
    // nie może go przemalować — żadnego `fill-*`, `text-*` ani `fill-current`
    // na kafelku. innerHTML jest bezpieczny: treść to stała z bundla
    // (`@/lib/appIcons`), nigdy nic z sieci ani od użytkownika.
    return <span aria-hidden="true" className={cn(TILE, className)} dangerouslySetInnerHTML={{ __html: mark }} />;
  }
  return (
    <div
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-raised text-[13px] font-semibold text-ink-secondary",
        className,
      )}
    >
      {card.label.slice(0, 1).toUpperCase()}
      {card.logo && !logoFailed && (
        <img src={card.logo} alt="" className="absolute inset-0 size-full" onError={() => setLogoFailed(true)} />
      )}
    </div>
  );
}

// multibot: kategorie katalogu. Identyfikatory pochodzą z serwera
// (`server/composio.ts` — CATEGORY_IDS), etykiety zostają tutaj, bo panel
// jest dwujęzyczny, a serwer nie zna języka klienta.
const CATEGORY_LABELS: Record<string, { pl: string; en: string }> = {
  google: { pl: "Google", en: "Google" },
  productivity: { pl: "Praca i dokumenty", en: "Productivity & documents" },
  developer: { pl: "Dla programistów", en: "Developer" },
  communication: { pl: "Komunikacja", en: "Communication" },
  design: { pl: "Design i media", en: "Design & media" },
  "data-ai": { pl: "Dane i AI", en: "Data & AI" },
  business: { pl: "Biznes", en: "Business" },
  other: { pl: "Inne", en: "Other" },
};
// Kolejność sekcji i szyny = kolejność kluczy wyżej, żeby lista id istniała
// w tym pliku dokładnie raz.
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
const categoryLabel = (id: string, polish: boolean) =>
  (CATEGORY_LABELS[id] ?? { pl: id, en: id })[polish ? "pl" : "en"];

// multibot (F7): własne konektory MCP — formularz i pomocnicy. Lustrzane
// stałe walidacji z server/mcp-connectors.ts, żeby błąd id pokazać od razu,
// bez rundy do serwera (resztę wsadu i tak waliduje backend — 400 idzie
// inline przez api()).
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const RESERVED_IDS = new Set(["composio", "computer", "agents", "ogb"]);
// ten sam wygląd co pole "Search apps" wyżej
const FIELD =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50";

type TransportType = "stdio" | "http" | "sse";
type CustomDraft = { id: string; name: string; type: TransportType; locked: boolean };
type KV = { k: string; v: string };

// Katalog nie zwraca transportu (env/headers to sekrety i zostają na
// serwerze) — typ do prefillu edycji czytamy z prefiksu blurba, który
// connectorCards() zawsze buduje jako "<transport>: …".
function typeFromBlurb(blurb: string): TransportType {
  return blurb.startsWith("http:") ? "http" : blurb.startsWith("sse:") ? "sse" : "stdio";
}

function kvToMap(rows: KV[]): Record<string, string> | undefined {
  const entries = rows.filter((r) => r.k.trim());
  return entries.length ? Object.fromEntries(entries.map((r) => [r.k.trim(), r.v])) : undefined;
}

// Zapis = PUT /api/connectors/custom/:id, zawsze nadpisuje CAŁY wpis — więc
// edycja nie prefilluje command/url/env/headers, tylko id (zablokowane),
// nazwę i typ transportu; użytkownik wpisuje resztę od nowa.
function ConnectorForm({
  draft,
  onSaved,
  onClose,
}: {
  draft: CustomDraft;
  onSaved: () => void;
  onClose: () => void;
}) {
  const polish = useLanguage() === "pl";
  const [id, setId] = useState(draft.id);
  const [name, setName] = useState(draft.name);
  const [type, setType] = useState<TransportType>(draft.type);
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  // env (stdio) albo headers (http/sse) — jedna lista, etykieta z typu
  const [pairs, setPairs] = useState<KV[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // multibot: wynik ostatniego PRAWDZIWEGO uścisku dłoni z serwerem MCP —
  // initialize + tools/list po stronie harnessa, nie zgadywanie z kształtu
  // formularza.
  const [probe, setProbe] = useState<{ ok: boolean; tools?: string[]; error?: string; serverName?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Wspólny wsad dla „Testuj" i „Zapisz" — jedno miejsce, w którym powstaje
  // transport, żeby test nie mógł sprawdzić czegoś innego niż to, co zapisze.
  const payload = () => {
    const cleanId = id.trim();
    if (!ID_RE.test(cleanId)) {
      setError("Id: lowercase letters, digits, - and _ only; must start with a letter or digit (max 61 chars).");
      return null;
    }
    if (RESERVED_IDS.has(cleanId)) {
      setError(`Id "${cleanId}" is reserved by a built-in integration.`);
      return null;
    }
    // stdio: jedno pole "command + argumenty", rozbijane po spacjach
    // (pierwszy token = command, reszta = args; argumenty ze spacjami
    // w cudzysłowie nie są wspierane)
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    const kv = kvToMap(pairs);
    if (type === "stdio" && !tokens.length) {
      setError(polish ? "Podaj polecenie serwera MCP." : "Enter the MCP server command.");
      return null;
    }
    if (type !== "stdio" && !/^https?:\/\//i.test(url.trim())) {
      setError(polish ? "Adres musi zaczynać się od http:// lub https://" : "The URL must start with http:// or https://");
      return null;
    }
    const transport =
      type === "stdio"
        ? {
            type,
            command: tokens[0] ?? "",
            ...(tokens.length > 1 ? { args: tokens.slice(1) } : {}),
            ...(kv ? { env: kv } : {}),
          }
        : { type, url: url.trim(), ...(kv ? { headers: kv } : {}) };
    return { cleanId, body: { name: name.trim() || cleanId, transport } };
  };

  const test = () => {
    setError(null);
    setProbe(null);
    const p = payload();
    if (!p) return;
    setTesting(true);
    api(`/api/connectors/custom/${p.cleanId}/test`, { method: "POST", body: JSON.stringify(p.body) })
      .then((r) => setProbe({ ok: Boolean(r.ok), tools: r.tools ?? [], error: r.error, serverName: r.serverName }))
      .catch((e) => setProbe({ ok: false, error: e.message }))
      .finally(() => setTesting(false));
  };

  const save = () => {
    setError(null);
    const p = payload();
    if (!p) return;
    setSaving(true);
    api(`/api/connectors/custom/${p.cleanId}`, { method: "PUT", body: JSON.stringify(p.body) })
      .then(() => {
        // Zamykamy OD RAZU po zapisie: konektor jest już w rejestrze, a
        // czekanie na sondę trzymałoby „Zapisz" w spinnerze przez pełne
        // 15 s, gdyby komenda wisiała.
        onSaved();
        // Sonda dopiero przy ZAPISANYM wpisie — wcześniej serwer nie ma gdzie
        // zapamiętać licznika (`recordProbe` bez wpisu to no-op). Wynik
        // dociąga listę drugi raz; porażka nic nie psuje.
        void api(`/api/connectors/custom/${p.cleanId}/test`, { method: "POST", body: "{}" })
          .then(() => onSaved())
          .catch(() => {});
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-2 rounded-xl border border-hairline/40 bg-card px-4 py-3">
      <div className="text-[13px] font-medium text-ink">
        {draft.locked ? `${polish ? "Edytuj" : "Edit"} ${draft.id}` : polish ? "Nowy serwer MCP" : "New MCP server"}
      </div>
      {draft.locked && (
        <div className="mt-1 text-[12px] text-warning">
          {polish ? "Przy edycji wpisz sekrety ponownie — zapis nadpisuje cały konektor." : "Re-enter secrets when editing — saving overwrites the whole connector."}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          disabled={draft.locked}
          placeholder="id (a-z, 0-9, -, _)"
          className={cn(FIELD, "flex-1")}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={polish ? "Nazwa" : "Name"}
          className={cn(FIELD, "flex-1")}
        />
      </div>
      <div className="mt-2 flex items-center gap-1">
        {(["stdio", "http", "sse"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px]",
              type === t ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {type === "stdio" ? (
        <>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx -y @your/mcp-server --flag"
            className={cn(FIELD, "mt-2")}
          />
          <div className="mt-1 text-[11px] text-ink-secondary">
            {polish ? "Polecenie i argumenty rozdziel spacjami." : "Command and arguments, separated by spaces."}
          </div>
        </>
      ) : (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/mcp"
          className={cn(FIELD, "mt-2")}
        />
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[12px] text-ink-secondary">
          {type === "stdio" ? polish ? "Zmienne środowiskowe" : "Environment variables" : polish ? "Nagłówki (np. Authorization)" : "Headers (e.g. Authorization)"}
        </span>
        <button
          onClick={() => setPairs((p) => [...p, { k: "", v: "" }])}
          className="text-[12px] text-ink-secondary underline hover:text-ink"
        >
          {polish ? "Dodaj" : "Add"} {type === "stdio" ? polish ? "zmienną" : "variable" : polish ? "nagłówek" : "header"}
        </button>
      </div>
      {pairs.map((row, i) => (
        <div key={i} className="mt-1.5 flex items-center gap-1.5">
          <input
            value={row.k}
            onChange={(e) => setPairs((p) => p.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))}
            placeholder={type === "stdio" ? "NAME" : "Header"}
            className={cn(FIELD, "flex-1")}
          />
          <input
            value={row.v}
            onChange={(e) => setPairs((p) => p.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))}
            placeholder={polish ? "Wartość" : "Value"}
            className={cn(FIELD, "flex-[2]")}
          />
          <button
            onClick={() => setPairs((p) => p.filter((_, j) => j !== i))}
            className="rounded-md p-1 text-ink-secondary hover:text-danger"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {probe && (
        <div className={cn("mt-2 rounded-lg px-3 py-2 text-[12px]", probe.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
          {probe.ok ? (
            <>
              {probe.serverName ? `${probe.serverName} — ` : ""}
              {polish ? "połączono, narzędzi: " : "connected — "}
              {probe.tools?.length ?? 0}
              {polish ? "" : " tools"}
              {probe.tools?.length ? <span className="text-ink-secondary">{` · ${probe.tools.slice(0, 6).join(", ")}`}</span> : null}
            </>
          ) : (
            probe.error
          )}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="w-[92px] rounded-lg bg-raised py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="mx-auto animate-spin" /> : polish ? "Zapisz" : "Save"}
        </button>
        <button
          onClick={test}
          disabled={testing}
          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50"
        >
          {testing ? <Loader2 size={13} className="mx-auto animate-spin" /> : polish ? "Testuj połączenie" : "Test connection"}
        </button>
        <button
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:text-ink"
        >
          {polish ? "Anuluj" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

// multibot (Google Workspace): guided preset samohostowanego workspace-mcp.
// Spec (ścieżka venvu, katalog credentials) buduje serwer — tu tylko client id
// + secret z Google Cloud. OAuth dzieje się w czacie: pierwsze wywołanie
// narzędzia zwraca botowi URL autoryzacji, token ląduje we wspólnym katalogu.
type GwStatus = { installed: boolean; configured: boolean; connected: boolean; installHint: string };

function GoogleWorkspaceSection() {
  const polish = useLanguage() === "pl";
  const [status, setStatus] = useState<GwStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api("/api/connectors/google-workspace")
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = () => {
    setBusy(true);
    setError(null);
    api("/api/connectors/google-workspace", {
      method: "PUT",
      body: JSON.stringify({ clientId, clientSecret: secret }),
    })
      .then((r) => {
        setStatus(r);
        setSecret("");
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const logout = () => {
    setBusy(true);
    api("/api/connectors/google-workspace/credentials", { method: "DELETE" })
      .then(setStatus)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  if (!status) return null;
  return (
    // multibot: własna zaokrąglona karta z odstępem, nie pas `border-t bg-card`
    // na całą szerokość. Poprzednia wersja stała w tym samym kolorze co karty
    // z siatki nad nią i bez żadnej przerwy, więc zjadała ich dolne rogi —
    // wyglądało to, jakby rozwinięta karta nachodziła na Reddita i Airtable.
    <div className="mt-2 rounded-xl bg-card">
      <div className="flex items-center gap-3 px-4 pb-1 pt-3">
        <ServiceIcon card={{ slug: "googledrive", label: "Google Workspace", blurb: "", logo: null }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
            Google Workspace
            {status.connected && <span className="size-1.5 rounded-full bg-success" />}
          </div>
          <div className="truncate text-[12px] text-ink-secondary">
            {polish
              ? "Gmail, Drive, Kalendarz i więcej — serwer MCP na tym hoście."
              : "Gmail, Drive, Calendar and more — MCP server on this host."}
          </div>
        </div>
        {status.configured && (
          <button
            disabled={busy || !status.connected}
            onClick={logout}
            title={polish ? "Usuń zapisane tokeny Google" : "Remove stored Google tokens"}
            className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink-secondary hover:text-danger disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="mx-auto animate-spin" /> : polish ? "Wyloguj" : "Log out"}
          </button>
        )}
      </div>
      {!status.installed && (
        <div className="mx-4 mb-2 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">
          {polish ? "Serwer nie jest zainstalowany. W terminalu hosta:" : "Server not installed. In the host terminal:"}
          <code className="mt-1 block break-all text-[11px] text-ink">{status.installHint}</code>
        </div>
      )}
      <div className="px-4 pb-3">
        {status.configured ? (
          <div className="text-[12px] text-ink-secondary">
            {status.connected
              ? polish
                ? "Połączono. Wszystkie boty korzystają z tego samego logowania Google."
                : "Connected. Every bot shares the same Google login."
              : polish
                ? "Konektor zapisany — poproś bota o akcję (np. „sprawdź maila\"), kliknij link autoryzacji w czacie."
                : "Connector saved — ask a bot for an action (e.g. \"check my email\"), tap the authorization link in chat."}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Google OAuth Client ID"
              className={FIELD}
            />
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              type="password"
              placeholder={polish ? "Client Secret (Google Cloud)" : "Client Secret (Google Cloud)"}
              className={FIELD}
            />
            {error && <div className="text-[12px] text-danger">{error}</div>}
            <button
              disabled={busy || !clientId.trim() || !secret.trim()}
              onClick={save}
              className="self-start rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : polish ? "Zainstaluj konektor" : "Install connector"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Karta aplikacji Composio: logo, nazwa, etykieta typu, konta, przyciski.
//
// MUSI stać w module, nie w ciele `PluginsPanel`: komponent zdefiniowany
// wewnątrz rodzica dostaje przy każdym renderze nową tożsamość, React
// odmontowuje poddrzewo i pole etykiety konta traciłoby focus po każdym
// wpisanym znaku (stan `alias` żyje w rodzicu).
function AppCard({
  card,
  accounts,
  connected,
  busySlug,
  waiting,
  configured,
  asking,
  alias,
  onAlias,
  onAsk,
  onConnect,
  onDisconnectAccount,
  onDisconnect,
}: {
  card: ToolkitCard;
  accounts: ConnectedAccount[];
  connected: boolean;
  busySlug: string | null;
  waiting: boolean;
  configured: boolean;
  asking: boolean;
  alias: string;
  onAlias: (value: string) => void;
  onAsk: () => void;
  onConnect: (slug: string, alias: string) => void;
  onDisconnectAccount: (slug: string, accountId: string) => void;
  onDisconnect: (slug: string) => void;
}) {
  const polish = useLanguage() === "pl";
  const busy = busySlug === card.slug;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <ServiceIcon card={card} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-ink">{card.label}</span>
            <span className="shrink-0 rounded bg-raised px-1.5 py-px text-[10px] uppercase tracking-wide text-ink-secondary">
              {polish ? "aplikacja OAuth" : "OAuth app"}
            </span>
          </div>
          <div className="line-clamp-2 text-[12px] leading-snug text-ink-secondary">{card.blurb}</div>
        </div>
        <button
          disabled={!configured || busy || waiting}
          onClick={onAsk}
          // Etykieta oczekiwania jedzie w `title`, nie w treści: pełne
          // „Czekam na autoryzację…" rozpychało przycisk na trzy czwarte
          // karty i nazwa aplikacji zwijała się do „G.".
          title={waiting ? (polish ? "Czekam na autoryzację…" : "Waiting for authorization…") : undefined}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-raised px-3 py-1 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {waiting ? (
            <Spinner size={12} />
          ) : busy ? (
            <Loader2 size={12} className="mx-auto animate-spin" />
          ) : connected ? (
            <><Plus size={12} />{polish ? "Konto" : "Account"}</>
          ) : (
            polish ? "Połącz" : "Connect"
          )}
        </button>
      </div>
      {asking && (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={alias}
            onChange={(e) => onAlias(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onConnect(card.slug, alias.trim()); if (e.key === "Escape") onAsk(); }}
            placeholder={polish ? "Etykieta konta, np. praca@gmail.com" : "Account label, e.g. work@gmail.com"}
            className={cn(FIELD, "flex-1")}
          />
          <button
            onClick={() => onConnect(card.slug, alias.trim())}
            className="shrink-0 rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover"
          >
            {polish ? "Połącz" : "Connect"}
          </button>
        </div>
      )}
      {/* Każde konto własnym wierszem — etykieta i własne odłączenie.
          Dwa konta tej samej aplikacji stoją tu obok siebie. */}
      {accounts.map((account) => (
        <div key={account.id} className="flex items-center gap-2 rounded-lg bg-inset px-2.5 py-1.5">
          <span className="size-1.5 shrink-0 rounded-full bg-success" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{account.alias || account.id}</span>
          <button
            type="button"
            disabled={busySlug === `${card.slug}:${account.id}`}
            onClick={() => onDisconnectAccount(card.slug, account.id)}
            aria-label={`Remove ${account.alias || account.id}`}
            className="shrink-0 rounded px-1 text-[12px] text-ink-secondary hover:text-danger disabled:opacity-50"
          >
            {busySlug === `${card.slug}:${account.id}` ? <Loader2 size={11} className="animate-spin" /> : polish ? "Odłącz" : "Disconnect"}
          </button>
        </div>
      ))}
      {connected && !accounts.length && (
        <button
          onClick={() => onDisconnect(card.slug)}
          className="self-start text-[12px] text-ink-secondary underline hover:text-danger"
        >
          {polish ? "Odłącz" : "Disconnect"}
        </button>
      )}
    </div>
  );
}

export function PluginsPanel() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [configured, setConfigured] = useState(true);
  const [status, setStatus] = useState<Record<string, { connected: boolean; accounts?: ConnectedAccount[] }>>({});
  const [busySlug, setBusySlug] = useState<string | null>(null);
  // OAuth kończy się w przeglądarce; kafelek czeka na wynik odpytywania.
  const [waitingSlug, setWaitingSlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // multibot: karta, na której otwarte jest pole etykiety konta. Osobne
  // konto = osobne kliknięcie „Połącz", więc pole musi dać się otworzyć
  // także wtedy, gdy aplikacja JEST już podłączona.
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [alias, setAlias] = useState("");
  // multibot (F7): otwarty formularz konektora — null = zamknięty,
  // locked = edycja istniejącego (id nie do zmiany)
  const [draft, setDraft] = useState<CustomDraft | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());
  // Odpytywanie po OAuth przeżywa zamknięcie panelu, jeśli mu na to pozwolić —
  // interwał wołałby setState na odmontowanym komponencie i odpytywał serwer
  // w kółko. Trzymamy uchwyty i kasujemy je przy odmontowaniu.
  // `clearInterval` i `clearTimeout` to w przeglądarce ta sama pula uchwytów,
  // więc jedna lista starczy na oba rodzaje zegara.
  const pollTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    const timers = pollTimers.current;
    return () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  }, []);

  // Podświetlenie w szynie idzie za KLIKNIĘCIEM, nie za pozycją scrolla —
  // obserwator przecięć dokładałby cały mechanizm po to, żeby powiedzieć to
  // samo w typowym użyciu (klik → skok → sekcja na górze).
  const [jumped, setJumped] = useState<string | null>(null);
  const jumpTo = useCallback((key: string) => {
    setJumped(key);
    sectionRefs.current.get(key)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  // multibot: prośba bota („Podłącz Google Workspace") stawia panel od razu
  // przy sekcji, w której ten konektor w ogóle stoi.
  const connector = state.pluginsConnector;
  useEffect(() => {
    if (connector === "google-workspace" || connector === "mcp") {
      // po pierwszym renderze — sekcja musi już istnieć w drzewie
      const timer = setTimeout(() => jumpTo("mcp"), 150);
      return () => clearTimeout(timer);
    }
  }, [connector, jumpTo]);

  // Zwraca świeżą mapę statusów, żeby wołający nie musiał czytać `status`
  // ze stanu (odpytywanie po OAuth zamykało się nad starą wartością i nigdy
  // nie widziało połączenia — pętla dochodziła do limitu prób).
  // `refreshing` NIE należy do tej funkcji: woła ją też odpytywanie po OAuth
  // (co 5 s przez minutę) oraz połącz/odłącz, a wtedy jej `finally` gasiło
  // ikonę w środku przeładowania katalogu i blokowało przycisk odświeżania na
  // czas cudzego obiegu. Kręcenie ikoną ma jednego właściciela: `loadCatalog`.
  // Postęp pojedynczej karty i tak widać po `waitingSlug` i `busySlug`.
  const refreshStatus = useCallback((slugs: string[]) => {
    if (!slugs.length) return Promise.resolve({} as Record<string, { connected: boolean; accounts?: ConnectedAccount[] }>);
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => {
        const services = r.services ?? {};
        setStatus((prev) => ({ ...prev, ...services }));
        return services as Record<string, { connected: boolean; accounts?: ConnectedAccount[] }>;
      })
      .catch(() => ({}) as Record<string, { connected: boolean; accounts?: ConnectedAccount[] }>);
  }, []);

  // multibot (F7): katalog przeładowuje się też po zapisie/usunięciu
  // własnego konektora, stąd useCallback zamiast gołego efektu. O status
  // pytamy tylko karty Composio — /api/connectors zna wyłącznie ich slugi.
  //
  // To JEST odświeżanie spod ikony w nagłówku: pełny obieg katalog → statusy.
  // Wcześniej wisiało tam samo `refreshStatus(composioCards…)`, czyli statusy
  // kart AKTUALNIE WIDOCZNYCH — przy wpisanej frazie albo pustym katalogu
  // lista slugów była pusta, `refreshStatus` wychodziło pierwszą linią i klik
  // nie robił nic, nawet nie zakręcił ikoną (0.5.33).
  // Kręcenie ikoną trzyma ten sam `refreshing` co statusy i gaśnie DOPIERO po
  // nich, stąd `return` w `then` zamiast `void`.
  const loadCatalog = useCallback(() => {
    setRefreshing(true);
    setError(null);
    return api("/api/connectors/catalog")
      .then((r) => {
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setConfigured(Boolean(r.configured));
        const composio = (r.cards ?? []).filter((c: ToolkitCard) => c.source !== "custom");
        if (r.configured) return refreshStatus(composio.map((c: ToolkitCard) => c.slug).slice(0, 100)).then(() => undefined);
      })
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, [refreshStatus]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Etykieta konta jedzie z pola w karcie, NIE z systemowego okienka:
  // Electron nie wspiera prompt() i rzuca wyjątkiem, więc w spakowanej apce
  // „Połącz" wywalało się jeszcze przed żądaniem — w przeglądarce działało,
  // na desktopie nie.
  const connect = (slug: string, label: string) => {
    setBusySlug(slug);
    setError(null);
    setAliasFor(null);
    setAlias("");
    api(`/api/connectors/${slug}/authorize`, { method: "POST", body: JSON.stringify(label ? { alias: label } : {}) })
      .then(({ url }) => {
        window.open(url);
        // the user finishes OAuth in the browser; poll a few times to catch it
        let tries = 0;
        setWaitingSlug(slug);
        // pierwsze odpytanie od razu: konta z aliasem Composio zakłada już przy
        // „add", więc wiersz konta pojawia się w karcie, zanim ktokolwiek
        // dokończy logowanie w przeglądarce. Uchwyt trafia do tej samej listy
        // co interwał — zamknięcie panelu w ciągu 800 ms nie może zostawić
        // setState na odmontowanym komponencie.
        const first = setTimeout(() => void refreshStatus([slug]), 800);
        pollTimers.current.push(first);
        const timer = setInterval(() => {
          void refreshStatus([slug]).then((fresh) => {
            if (++tries >= 12 || fresh[slug]?.connected) {
              clearInterval(timer);
              pollTimers.current = pollTimers.current.filter((t) => t !== timer);
              setWaitingSlug(null);
            }
          });
        }, 5000);
        pollTimers.current.push(timer);
      })
      .catch((e) => { setError(e.message); setWaitingSlug(null); })
      .finally(() => setBusySlug(null));
  };

  const disconnectAccount = (slug: string, accountId: string) => {
    setBusySlug(`${slug}:${accountId}`);
    api(`/api/connectors/${slug}/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  // multibot: odłączenie wszystkich kont aplikacji naraz
  const disconnect = (slug: string) => {
    setBusySlug(slug);
    api(`/api/connectors/${slug}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  // multibot (F7): własne konektory usuwa harness, nie Composio — osobna
  // trasa /custom/ i pełne przeładowanie katalogu (statusów tu nie ma).
  const removeCustom = (id: string) => {
    setBusySlug(id);
    setError(null);
    api(`/api/connectors/custom/${id}`, { method: "DELETE" })
      .then(() => loadCatalog())
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const all = cards ?? [];
  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () => (query ? all.filter((c) => `${c.label} ${c.slug} ${c.blurb}`.toLowerCase().includes(query)) : all),
    [all, query],
  );
  const composioCards = visible.filter((c) => c.source !== "custom");
  const customCards = visible.filter((c) => c.source === "custom");
  const installed = composioCards.filter((c) => status[c.slug]?.connected);
  // licznik nad panelem liczy KONTA, nie aplikacje — dwa Gmaile to dwa
  // połączenia, i tak je widać w sekcji „Zainstalowane"
  const installedCount =
    all.filter((c) => c.source !== "custom").reduce((n, c) => n + (status[c.slug]?.accounts?.length || (status[c.slug]?.connected ? 1 : 0)), 0) +
    all.filter((c) => c.source === "custom").length;
  const installedIcons = all
    .filter((c) => (c.source === "custom" ? true : status[c.slug]?.connected))
    .slice(0, 6);

  const installedSlugs = useMemo(() => new Set(installed.map((c) => c.slug)), [installed]);

  // Sekcje w kolejności szyny; kategorie puste znikają. Aplikacja PODŁĄCZONA
  // znika ze swojej kategorii i mieszka wyłącznie w „Zainstalowane" — inaczej
  // ta sama karta stała w dwóch miejscach naraz, a stan pola etykiety jest
  // trzymany po slugu, więc „+ Konto" otwierało input w OBU kopiach.
  const sections = useMemo(() => {
    const byCategory = new Map<string, ToolkitCard[]>();
    for (const card of composioCards) {
      if (installedSlugs.has(card.slug)) continue;
      const id = card.category && CATEGORY_LABELS[card.category] ? card.category : "other";
      const list = byCategory.get(id);
      if (list) list.push(card);
      else byCategory.set(id, [card]);
    }
    return CATEGORY_ORDER.filter((id) => byCategory.get(id)?.length).map((id) => ({
      id: id as string,
      label: categoryLabel(id, polish),
      cards: byCategory.get(id) ?? [],
    }));
  }, [composioCards, installedSlugs, polish]);

  const railItems = [
    ...(installed.length || customCards.length ? [{ id: "installed", label: polish ? "Zainstalowane" : "Installed" }] : []),
    ...sections.map((s) => ({ id: s.id, label: s.label })),
    { id: "mcp", label: polish ? "Serwery MCP" : "MCP servers" },
  ];

  const setSectionRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(key, el);
    else sectionRefs.current.delete(key);
  };

  // Props karty składane w jednym miejscu — obie sekcje („Zainstalowane"
  // i kategoria) rysują tę samą kartę.
  const cardProps = (card: ToolkitCard) => ({
    card,
    accounts: status[card.slug]?.accounts ?? [],
    connected: Boolean(status[card.slug]?.connected) || (status[card.slug]?.accounts?.length ?? 0) > 0,
    busySlug,
    waiting: waitingSlug === card.slug,
    configured,
    asking: aliasFor === card.slug,
    alias,
    onAlias: setAlias,
    onAsk: () => { setAliasFor(aliasFor === card.slug ? null : card.slug); setAlias(""); },
    onConnect: connect,
    onDisconnectAccount: disconnectAccount,
    onDisconnect: disconnect,
  });

  return (
    <div
      // multibot: `data-shell-overlay` = w oknie bez ramki ten obszar NIE jest
      // uchwytem do przeciągania (src/styles.css, punkt 5). Bez tego Chromium
      // zostawiał tu region `drag` z nagłówka czatu spod spodu i górne 72 px
      // nakładki — czyli cały ten nagłówek z „X" i odświeżaniem — zjadały
      // każde kliknięcie (0.5.33).
      data-shell-overlay
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-3 md:p-6"
      onClick={() => dispatch({ type: "togglePlugins", open: false })}
    >
      <div
        // multibot: JEDEN plik, dwa układy. Poniżej `md` zostaje dokładnie
        // ten kompaktowy panel co wcześniej (`w-full max-w-[640px]`,
        // `max-h-[85%]`, jedna kolumna) — telefon renderuje ten sam bundle
        // i ma zostać bez zmian. Od `md` w górę okno rośnie do rozmiaru
        // aplikacji minus margines overlaya i dostaje lewą szynę kategorii.
        className="animate-pop-in flex max-h-[85%] w-full max-w-[640px] flex-col rounded-2xl border border-hairline/50 bg-panel p-4 shadow-2xl md:h-full md:max-h-none md:max-w-[1400px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* `min-w-0` na tytule i `shrink` na pigułce: przycisk domyślnie ma
            `min-width:auto`, więc na wąskim ekranie wiersz nagłówka rozpychał
            się i wypychał „X" poza panel. Ikon w pigułce mniej niż na
            desktopie z tego samego powodu. */}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">
            {polish ? "Wtyczki" : "Plugins"}
          </div>
          <div className="flex shrink items-center gap-2">
            {/* „N zainstalowanych ›" z ikonami połączonych aplikacji */}
            <button
              onClick={() => jumpTo("installed")}
              className="flex min-w-0 items-center gap-2 whitespace-nowrap rounded-full bg-raised/60 py-1 pl-2 pr-3 text-[12.5px] text-ink-secondary hover:text-ink"
            >
              <span className="flex -space-x-1.5">
                {installedIcons.slice(0, 3).map((card) => (
                  <ServiceIcon key={card.slug} card={card} className="size-5 rounded p-0.5" />
                ))}
                {installedIcons.slice(3).map((card) => (
                  <ServiceIcon key={card.slug} card={card} className="hidden size-5 rounded p-0.5 md:grid" />
                ))}
              </span>
              {installedCount}
              <span className="hidden sm:inline">{polish ? " zainstalowanych" : " installed"}</span> ›
            </button>
            {/* Prawdziwy <button>, nie samo <svg> z `onClick`: bez tego ikona
                jest poza kolejnością tabulacji i nie da się jej wcisnąć
                klawiaturą, a w oknie bez ramki nie łapie jej też wyjątek
                `no-drag` dla przycisków w nagłówku. */}
            <button
              type="button"
              onClick={() => void loadCatalog()}
              disabled={refreshing}
              aria-label={polish ? "Odśwież" : "Refresh"}
              title={polish ? "Odśwież" : "Refresh"}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
            >
              <RefreshCw size={14} className={cn("shrink-0", refreshing && "animate-spin")} />
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "togglePlugins", open: false })}
              aria-label={polish ? "Zamknij" : "Close"}
              title={polish ? "Zamknij" : "Close"}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={polish ? "Szukaj wtyczek i botów" : "Search plugins and bots"}
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />

        {!configured && (
          <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">
            {polish ? "Brak klucza Composio Connect — " : "No Composio Connect key yet — "}
            <button
              className="underline"
              onClick={() => {
                dispatch({ type: "togglePlugins", open: false });
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              {polish ? "dodaj go w ustawieniach aplikacji" : "add one in App Settings"}
            </button>{" "}
            {polish ? "aby połączyć aplikacje. Własne serwery MCP działają bez niego." : "to connect apps. Your own MCP servers work without it."}
          </div>
        )}
        {configured && source === "curated" && (
          <div className="mt-2 text-[12px] text-ink-secondary">
            {polish ? "Wyświetlam wybrany zestaw. " : "Showing a curated set. "}
            <button
              className="underline hover:text-ink"
              onClick={() => {
                dispatch({ type: "togglePlugins", open: false });
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              {polish ? "Dodaj klucz API Composio" : "Add a Composio API key"}
            </button>{" "}
            {polish ? "aby przeglądać pełny katalog." : "to browse the full catalog."}
          </div>
        )}
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}

        {/* Wąski ekran: pigułki kategorii zamiast szyny. `shrink-0`
            obowiązkowe — bez niego kolumna flex ściska pasek i pigułki
            wychodzą przycięte w pół. */}
        <div className="mt-3 flex shrink-0 gap-1.5 overflow-x-auto pb-1 md:hidden">
          {railItems.map((item) => (
            <button
              key={item.id}
              onClick={() => jumpTo(item.id)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-[12px]",
                jumped === item.id ? "bg-raised text-ink" : "bg-raised/60 text-ink-secondary hover:text-ink",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex min-h-0 flex-1 gap-4">
          {/* lewa szyna — tylko na desktopie */}
          <nav className="hidden w-[190px] shrink-0 flex-col gap-0.5 overflow-y-auto md:flex">
            {railItems.map((item) => (
              <button
                key={item.id}
                onClick={() => jumpTo(item.id)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-left text-[13px] hover:bg-raised/60 hover:text-ink",
                  jumped === item.id ? "bg-raised/60 font-medium text-ink" : "text-ink-secondary",
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {cards === null ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-secondary">
                <Loader2 size={14} className="animate-spin" /> {polish ? "Ładowanie katalogu…" : "Loading catalog…"}
              </div>
            ) : (
              <>
                {/* ── Zainstalowane ── */}
                {(installed.length > 0 || customCards.length > 0) && (
                  <div ref={setSectionRef("installed")} className="mb-5 scroll-mt-2">
                    <div className="mb-2 text-[13px] font-medium text-ink-secondary">
                      {polish ? "Zainstalowane" : "Installed"}
                    </div>
                    <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {installed.map((card) => (
                        <AppCard key={`installed-${card.slug}`} {...cardProps(card)} />
                      ))}
                      {customCards.map((card) => (
                        <div key={`installed-${card.slug}`} className="flex items-start gap-3 rounded-xl bg-card px-4 py-3">
                          <ServiceIcon card={card} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-[14px] font-medium text-ink">{card.label}</span>
                              <span className="shrink-0 rounded bg-raised px-1.5 py-px text-[10px] uppercase tracking-wide text-ink-secondary">MCP</span>
                            </div>
                            <div className="truncate text-[12px] text-ink-secondary">{card.blurb}</div>
                          </div>
                          {typeof card.tools === "number" && (
                            <span className="shrink-0 pt-0.5 text-[12px] text-ink-secondary">
                              {card.tools} {polish ? "narz." : "tools"}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── katalog po kategoriach ── */}
                {sections.length === 0 && customCards.length === 0 ? (
                  <div className="py-8 text-center text-[13px] text-ink-secondary">
                    {polish ? "Brak pasujących aplikacji." : "No apps match."}
                  </div>
                ) : (
                  sections.map((section) => (
                    <div key={section.id} ref={setSectionRef(section.id)} className="mb-5 scroll-mt-2">
                      <div className="mb-2 text-[13px] font-medium text-ink-secondary">{section.label}</div>
                      <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {section.cards.map((card) => (
                          <AppCard key={card.slug} {...cardProps(card)} />
                        ))}
                      </div>
                    </div>
                  ))
                )}

                {/* multibot (F7): własne serwery MCP. Trasy
                    /api/connectors/custom/* to harness, nie Composio —
                    działają bez klucza, więc nic tu nie jest gate'owane
                    przez `configured`. */}
                <div ref={setSectionRef("mcp")} className="mb-4 scroll-mt-2 border-t border-hairline/40 pt-4">
                  <div className="flex items-center justify-between pb-1">
                    <div>
                      <div className="text-[13px] font-semibold text-ink">{polish ? "Serwery MCP" : "MCP servers"}</div>
                      <div className="text-[12px] text-ink-secondary">
                        {polish ? "Twoje serwery MCP — stdio, HTTP lub SSE." : "Your own MCP servers — stdio, HTTP or SSE."}
                      </div>
                    </div>
                    <button
                      onClick={() => setDraft({ id: "", name: "", type: "stdio", locked: false })}
                      className="flex items-center gap-1 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                    >
                      <Plus size={13} />
                      {polish ? "Dodaj serwer" : "Add server"}
                    </button>
                  </div>
                  {customCards.map((card) => {
                    const busy = busySlug === card.slug;
                    return (
                      <div key={card.slug} className="flex items-center gap-3 border-t border-hairline/40 py-3">
                        <ServiceIcon card={card} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[14px] font-medium text-ink">{card.label}</span>
                            <span className="shrink-0 rounded bg-raised px-1.5 py-px text-[10px] uppercase tracking-wide text-ink-secondary">MCP</span>
                            {typeof card.tools === "number" && (
                              <span className="text-[12px] text-ink-secondary">
                                {card.tools} {polish ? "narzędzi" : "tools"}
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[12px] text-ink-secondary">{card.blurb}</div>
                        </div>
                        <button
                          disabled={busy}
                          onClick={() =>
                            setDraft({
                              id: card.slug,
                              name: card.label,
                              type: typeFromBlurb(card.blurb),
                              locked: true,
                            })
                          }
                          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                        >
                          {polish ? "Edytuj" : "Edit"}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => removeCustom(card.slug)}
                          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink-secondary hover:text-danger disabled:opacity-50"
                        >
                          {busy ? <Loader2 size={13} className="mx-auto animate-spin" /> : polish ? "Usuń" : "Remove"}
                        </button>
                      </div>
                    );
                  })}
                  {draft && (
                    <ConnectorForm
                      key={draft.locked ? draft.id : "new"}
                      draft={draft}
                      onClose={() => setDraft(null)}
                      onSaved={() => {
                        setDraft(null);
                        void loadCatalog();
                      }}
                    />
                  )}
                  {/* guided preset — zapis stąd trafia do tego samego rejestru */}
                  <GoogleWorkspaceSection />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
