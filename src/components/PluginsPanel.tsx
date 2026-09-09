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
// (source === "custom") — renderowane w sekcji "Custom connectors" niżej,
// obsługiwane trasami harnessa /api/connectors/custom/:id (działają bez
// klucza Composio).
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "./Loading";
import { Loader2, RefreshCw, X } from "lucide-react";
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
}
interface ConnectedAccount { id: string; alias?: string; status: string }

// Kafelek pod znakiem: JASNY w każdym motywie, nie `bg-raised` — `--color-raised`
// jest ciemne w motywach ciemnych, a wtedy czarne marki (GitHub, X, OpenAI,
// Vercel) znikają. Tak samo trzyma katalog Composio i Zapier.
const TILE =
  "grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-white p-1.5 " +
  "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] [&>svg]:size-full";

function ServiceIcon({ card }: { card: ToolkitCard }) {
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
    return <span aria-hidden="true" className={TILE} dangerouslySetInnerHTML={{ __html: mark }} />;
  }
  return (
    <div className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-raised text-[13px] font-semibold text-ink-secondary">
      {card.label.slice(0, 1).toUpperCase()}
      {card.logo && !logoFailed && (
        <img src={card.logo} alt="" className="absolute inset-0 size-8" onError={() => setLogoFailed(true)} />
      )}
    </div>
  );
}

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
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const cleanId = id.trim();
    if (!ID_RE.test(cleanId)) {
      setError("Id: lowercase letters, digits, - and _ only; must start with a letter or digit (max 61 chars).");
      return;
    }
    if (RESERVED_IDS.has(cleanId)) {
      setError(`Id "${cleanId}" is reserved by a built-in integration.`);
      return;
    }
    // stdio: jedno pole "command + argumenty", rozbijane po spacjach
    // (pierwszy token = command, reszta = args; argumenty ze spacjami
    // w cudzysłowie nie są wspierane)
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    const kv = kvToMap(pairs);
    const transport =
      type === "stdio"
        ? {
            type,
            command: tokens[0] ?? "",
            ...(tokens.length > 1 ? { args: tokens.slice(1) } : {}),
            ...(kv ? { env: kv } : {}),
          }
        : { type, url: url.trim(), ...(kv ? { headers: kv } : {}) };
    setSaving(true);
    setError(null);
    api(`/api/connectors/custom/${cleanId}`, {
      method: "PUT",
      body: JSON.stringify({ name: name.trim() || cleanId, transport }),
    })
      .then(onSaved)
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="border-t border-hairline/40 bg-card px-4 py-3">
      <div className="text-[13px] font-medium text-ink">
        {draft.locked ? `${polish ? "Edytuj" : "Edit"} ${draft.id}` : polish ? "Nowy konektor" : "New connector"}
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
          {type === "stdio" ? polish ? "Zmienne środowiskowe" : "Environment variables" : polish ? "Nagłówki" : "Headers"}
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
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="w-[92px] rounded-lg bg-raised py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="mx-auto animate-spin" /> : polish ? "Zapisz" : "Save"}
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
  const [tab, setTab] = useState<"marketplace" | "yours">("marketplace");
  // multibot (F7): otwarty formularz konektora — null = zamknięty,
  // locked = edycja istniejącego (id nie do zmiany)
  const [draft, setDraft] = useState<CustomDraft | null>(null);

  // multibot: prośba bota („Podłącz Google Workspace") stawia panel od razu na
  // zakładce, na której ten konektor w ogóle stoi — obie żyją pod „Twoje".
  // Efekt, a nie wartość początkowa: panel bywa już otwarty, gdy klikasz kartę.
  const connector = state.pluginsConnector;
  useEffect(() => {
    if (connector === "google-workspace" || connector === "mcp") setTab("yours");
  }, [connector]);

  const refreshStatus = useCallback((slugs: string[]) => {
    if (!slugs.length) return Promise.resolve();
    setRefreshing(true);
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => setStatus(r.services ?? {}))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, []);

  // multibot (F7): katalog przeładowuje się też po zapisie/usunięciu
  // własnego konektora, stąd useCallback zamiast gołego efektu. O status
  // pytamy tylko karty Composio — /api/connectors zna wyłącznie ich slugi.
  const loadCatalog = useCallback(() => {
    return api("/api/connectors/catalog")
      .then((r) => {
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setConfigured(Boolean(r.configured));
        const composio = (r.cards ?? []).filter((c: ToolkitCard) => c.source !== "custom");
        if (r.configured) void refreshStatus(composio.map((c: ToolkitCard) => c.slug).slice(0, 100));
      })
      .catch((e) => setError(e.message));
  }, [refreshStatus]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const connect = (slug: string) => {
    setBusySlug(slug);
    setError(null);
    const alias = window.prompt(polish ? "Nazwa konta (opcjonalnie)" : "Account label (optional)", "")?.trim() ?? "";
    api(`/api/connectors/${slug}/authorize`, { method: "POST", body: JSON.stringify(alias ? { alias } : {}) })
      .then(({ url }) => {
        window.open(url);
        // the user finishes OAuth in the browser; poll a few times to catch it
        let tries = 0;
        setWaitingSlug(slug);
        const timer = setInterval(() => {
          void refreshStatus([slug]);
          if (++tries >= 6 || status[slug]?.connected) {
            clearInterval(timer);
            setWaitingSlug(null);
          }
        }, 5000);
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

  // multibot: odłączenie z zakładki "Yours" — klik na ✓ Added tam też działa
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

  const visible = (cards ?? []).filter(
    (c) => !search || `${c.label} ${c.slug} ${c.blurb}`.toLowerCase().includes(search.toLowerCase()),
  );
  // multibot (F7): Composio renderuje się jak dotąd, własne konektory idą
  // do sekcji "Custom connectors" na dole listy
  const composioCards = visible.filter((c) => c.source !== "custom");
  const customCards = visible.filter((c) => c.source === "custom");

  const yourCards = tab === "yours" ? composioCards.filter((c) => status[c.slug]?.connected) : [];

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-3"
      onClick={() => dispatch({ type: "togglePlugins", open: false })}
    >
      <div
        // multibot: ta sama karta na telefonie i na desktopie — szerokość
        // idzie za kontenerem i zatrzymuje się na 640px, więc na wąskim
        // ekranie karta po prostu maleje, a siatka niżej schodzi do jednej
        // kolumny poniżej `sm`. Odstęp od krawędzi daje `p-3` na overlayu.
        className="animate-pop-in flex max-h-[85%] w-full max-w-[640px] flex-col rounded-2xl border border-hairline/50 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-[17px] font-semibold text-ink">{polish ? "Wtyczki" : "Plugins"}</div>
          <button
            onClick={() => dispatch({ type: "togglePlugins", open: false })}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tabs + filter + search — jak na screenie Marketplace */}
        {/* flex-wrap: na wąskim ekranie szukajka schodzi pod zakładki
            zamiast ściskać je do nieczytelnej szerokości */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg bg-raised/60 p-0.5">
            {([
              ["marketplace", polish ? "Marketplace" : "Marketplace"],
              ["yours", polish ? "Twoje" : "Yours"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[13px]",
                  tab === key ? "bg-card font-medium text-ink shadow" : "text-ink-secondary hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
            <RefreshCw
              size={14}
              className={cn("shrink-0 cursor-pointer text-ink-secondary hover:text-ink", refreshing && "animate-spin")}
              onClick={() => refreshStatus(composioCards.map((c) => c.slug).slice(0, 100))}
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={polish ? "Szukaj wtyczek" : "Search plugins"}
              className="w-full max-w-[260px] rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
          </div>
        </div>

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
            {polish ? "aby połączyć aplikacje." : "to connect apps."}
          </div>
        )}
        {configured && source === "curated" && tab === "marketplace" && (
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

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {cards === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-secondary">
              <Loader2 size={14} className="animate-spin" /> {polish ? "Ładowanie katalogu…" : "Loading catalog…"}
            </div>
          ) : tab === "yours" ? (
            /* ── Yours — połączone aplikacje ── */
            yourCards.length === 0 ? (
              <div className="py-8 text-center text-[13px] text-ink-secondary">{polish ? "Nic jeszcze nie połączone." : "Nothing connected yet."}</div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {yourCards.map((card) => {
                  const busy = busySlug === card.slug;
                  return (
                    <div key={card.slug} className="flex items-center gap-3 rounded-xl bg-card px-4 py-3">
                      <ServiceIcon card={card} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
                        <div className="truncate text-[12px] text-ink-secondary">{card.blurb}</div>
                        {!!status[card.slug]?.accounts?.length && <div className="mt-1 flex flex-wrap gap-1">{status[card.slug]?.accounts?.map((account) => <span key={account.id} className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-secondary">{account.alias || account.id}<button type="button" onClick={() => disconnectAccount(card.slug, account.id)} aria-label={`Remove ${account.alias || account.id}`} className="text-danger">×</button></span>)}</div>}
                      </div>
                      <button
                        disabled={busy}
                        onClick={() => disconnect(card.slug)}
                        title={polish ? "Odłącz" : "Disconnect"}
                        className="shrink-0 rounded-full bg-raised px-3 py-1 text-[12.5px] text-ink-secondary hover:text-danger disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={12} className="mx-auto animate-spin" /> : polish ? "Odłącz" : "Disconnect"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            /* ── Marketplace — jedna lista „Wszystkie aplikacje" ──
                 multibot: bez zakładki/sekcji „Wyróżnione". Katalog jest
                 posortowany przez serwer (Composio: po użyciu), a do
                 zawężania jest wyszukiwarka wyżej — dzielenie go na kubełki
                 tylko chowało aplikacje przed osobą, która wie, czego szuka. */
            composioCards.length === 0 ? (
              <div className="py-8 text-center text-[13px] text-ink-secondary">{polish ? "Brak pasujących aplikacji." : "No apps match."}</div>
            ) : (
              <div className="mb-4">
                <div className="mb-2 text-[13px] font-medium text-ink-secondary">
                  {polish ? "Wszystkie aplikacje" : "All apps"}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {composioCards.map((card) => {
                    const connected = status[card.slug]?.connected;
                    const busy = busySlug === card.slug;
                    return (
                      <div key={card.slug} className="flex items-start gap-3 rounded-xl bg-card px-4 py-3">
                        <ServiceIcon card={card} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-medium text-ink">{card.label}</div>
                          <div className="line-clamp-2 text-[12px] leading-snug text-ink-secondary">{card.blurb}</div>
                        </div>
                        {connected ? (
                          <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[12.5px] text-success">
                            ✓ {polish ? "Dodano" : "Added"}
                          </span>
                        ) : (
                          <button
                            disabled={!configured || busy || waitingSlug === card.slug}
                            onClick={() => connect(card.slug)}
                            className="flex shrink-0 items-center gap-1.5 rounded-full bg-raised px-3 py-1 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
                          >
                            {waitingSlug === card.slug ? (
                              <><Spinner size={12} />{polish ? "Czekam na autoryzację…" : "Waiting for authorization…"}</>
                            ) : busy ? <Loader2 size={12} className="mx-auto animate-spin" /> : polish ? "Dodaj" : "Add"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          )}

          {/* multibot (Google Workspace): guided preset nad własnymi
              konektorami — zapis spod tad trafia do tego samego rejestru. */}
          {tab === "yours" && <GoogleWorkspaceSection />}

          {/* multibot (F7): sekcja własnych serwerów MCP pod katalogiem
              Composio. Trasy /api/connectors/custom/* to harness, nie
              Composio — działają bez klucza, więc nic tu nie jest
              gate'owane przez `configured`. Kropki statusu też nie ma:
              /api/connectors zna tylko slugi Composio. */}
          {tab === "yours" && cards !== null && (
            <div className="mt-3 border-t border-hairline/40 pt-3">
              <div className="flex items-center justify-between pb-1">
                <div>
                  <div className="text-[13px] font-semibold text-ink">{polish ? "Własne konektory" : "Custom connectors"}</div>
                  <div className="text-[12px] text-ink-secondary">
                    {polish ? "Twoje serwery MCP — stdio, HTTP lub SSE." : "Your own MCP servers — stdio, HTTP or SSE."}
                  </div>
                </div>
                <button
                  onClick={() => setDraft({ id: "", name: "", type: "stdio", locked: false })}
                  className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover"
                >
                  {polish ? "Dodaj konektor" : "Add connector"}
                </button>
              </div>
              {customCards.map((card) => {
                const busy = busySlug === card.slug;
                return (
                  <div
                    key={card.slug}
                    className="flex items-center gap-3 border-t border-hairline/40 py-3"
                  >
                    <ServiceIcon card={card} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-ink">{card.label}</div>
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
