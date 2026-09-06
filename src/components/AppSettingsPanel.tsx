// App-level settings screen: who you are + credentials
// shared by all bots. Per-bot settings (name, persona, model, computer)
// live in SettingsPanel; contextual Box-token entry stays in ComputerPanel.
import { ArrowLeft, Copy, FileDown, Loader2, Plus, Trash2 } from "lucide-react";
// multibot: ikony szyny sekcji przerysowane z lucide, żeby dało się animować
// ich części na kliknięcie (suwaki jeżdżą, strzałki się kręcą, klucz dokręca).
import { RefreshTabIcon, SlidersTabIcon, WrenchTabIcon } from "./SettingsTabIcons";
// multibot: piąta kopia tej samej linii (App.tsx, ChatView.tsx, Onboarding.tsx,
// Sidebar.tsx). Tu decyduje o jednym: czy pokazać przełącznik akceleracji.
const isElectron = navigator.userAgent.includes("Electron");
import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { authFetch, clearAuthToken } from "@/lib/auth";
import { languageLabel, setLanguage, useLanguage, type Language } from "@/lib/language";
import { SkinPicker } from "./SkinPicker";
import { MicrophoneRow } from "./MicrophoneRow";
import { BotSettingsCard } from "./BotSettingsCard";
import { applyMotionMode, readMotionMode, type MotionMode } from "@/lib/motion";
import { readDesktopNotifications, requestBrowserNotifications, setDesktopNotifications } from "@/lib/notifications";

const slug = (value: string) =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);

// Własny helper zamiast gołego authFetch: część tras harnessu oddaje błąd
// jako `{detail}`, część jako `{error}`, a `status` pozwala odróżnić awarię
// serwera od komunikatu dla usera.
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    const err = new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return body;
}

type DeviceResources = {
  ram: { totalBytes: number; freeBytes: number };
  cpu: { count: number; load: number };
  disk: { totalBytes: number; freeBytes: number } | null;
  temperatures: Array<{ name: string; celsius: number }>;
};

function bytes(value: number | undefined): string {
  if (!value) return "—";
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function MachineResources() {
  const polish = useLanguage() === "pl";
  const [resources, setResources] = useState<DeviceResources | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => authFetch("/api/device/resources")
      .then((response) => response.json())
      .then((value) => alive && setResources(value as DeviceResources))
      .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Zasoby urządzenia" : "Machine resources"}</div>
      {resources ? <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] text-ink-secondary">
        <span>RAM <b className="font-medium text-ink">{bytes(resources.ram.totalBytes - resources.ram.freeBytes)} / {bytes(resources.ram.totalBytes)}</b></span>
        <span>CPU <b className="font-medium text-ink">{Math.round(resources.cpu.load * 100)}% · {resources.cpu.count} {polish ? "rdzeni" : "cores"}</b></span>
        <span>{polish ? "Dysk" : "Disk"} <b className="font-medium text-ink">{resources.disk ? `${bytes(resources.disk.totalBytes - resources.disk.freeBytes)} / ${bytes(resources.disk.totalBytes)}` : "—"}</b></span>
        {resources.temperatures.length > 0 && <span>{polish ? "Temperatura" : "Temperature"} <b className="font-medium text-ink">{Math.round(resources.temperatures[0].celsius)}°C</b></span>}
      </div> : <div className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{polish ? "Sprawdzanie…" : "Checking…"}</div>}
    </div>
  );
}

function DiagnosticsRow() {
  const polish = useLanguage() === "pl";
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const exportReport = async () => {
    if (!window.ogb?.exportDiagnostics) return;
    setBusy(true);
    setResult(null);
    try {
      const report = await window.ogb.exportDiagnostics();
      if (report.ok && report.path) setResult(polish ? "Zapisano raport." : "Report saved.");
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl bg-card p-4">
      <FileDown size={18} className="shrink-0 text-ink-secondary" />
      <div className="min-w-0 flex-1"><div className="text-[15px] font-medium text-ink">{polish ? "Diagnostyka" : "Diagnostics"}</div><div className="mt-0.5 text-[12px] text-ink-secondary">{polish ? "Raport bez kluczy i tokenów." : "Report with keys and tokens redacted."}</div>{result && <div className="mt-1 text-[12px] text-success">{result}</div>}</div>
      <button type="button" disabled={busy || !window.ogb?.exportDiagnostics} onClick={() => void exportReport()} className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40">{busy ? <Loader2 size={14} className="animate-spin" /> : polish ? "Eksportuj" : "Export"}</button>
    </div>
  );
}

/** v2 profile: username is immutable; display name labels messages. */
function ProfileFields() {
  const { state } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [username, setUsername] = useState("");
  const polish = useLanguage() === "pl";
  useEffect(() => {
    void authFetch("/api/profile")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((body) => {
        setName(body.user?.displayName ?? state.config?.profile?.name ?? "");
        setUsername(body.user?.username ?? "");
      })
      .catch(() => setName(state.config?.profile?.name ?? ""));
  }, [state.config?.profile?.name]);

  const save = () => {
    void authFetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: name.trim() }),
    }).catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder={polish ? "Nazwa wyświetlana" : "Display name"} className={inputClass} />
      <input readOnly value={username} placeholder={polish ? "Nazwa użytkownika" : "Username"} className={`${inputClass} opacity-60`} />
    </div>
  );
}

export function AccessTokenSettings() {
  const polish = useLanguage() === "pl";
  const [account, setAccount] = useState<any>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; deviceName: string; lastSeenAt: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api("/api/auth/me"), api("/api/auth/sessions")])
      .then(([me, sessionBody]) => { setAccount(me); setSessions(sessionBody.sessions ?? []); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const logout = async (all: boolean) => {
    await authFetch(`/api/auth/logout${all ? "-all" : ""}`, { method: "POST" }).catch(() => {});
    clearAuthToken();
    window.location.reload();
  };

  const revoke = async (id: string) => {
    if (!(await authFetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })).ok) return;
    setSessions((current) => current.filter((session) => session.id !== id));
  };

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Konto i sesje" : "Account & sessions"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Każde urządzenie loguje się własną sesją. Tokeny techniczne nie są pokazywane." : "Each device has its own session. Technical tokens are never displayed."}</div>
      {account?.user && <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[13px] text-ink">{account.user.displayName} <span className="text-ink-secondary">· @{account.user.username} · {account.user.role}</span></div>}
      {sessions.length > 0 && <div className="mt-3 space-y-1 text-[12px] text-ink-secondary">{sessions.map((session) => <div key={session.id} className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{session.deviceName}</span><button type="button" onClick={() => void revoke(session.id)} className="text-ink hover:text-danger">{polish ? "Unieważnij" : "Revoke"}</button></div>)}</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void logout(false)} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover">{polish ? "Wyloguj" : "Log out"}</button>
        <button type="button" onClick={() => void logout(true)} className="rounded-lg border border-danger/40 px-3 py-2 text-[13px] text-danger hover:bg-danger/10">{polish ? "Wyloguj wszystkie urządzenia" : "Log out all devices"}</button>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** Same rule as `isServerName` in server/identity.ts. Duplicated rather than
 * imported: that module pulls in node:sqlite and has no business in the bundle. */
function isServerName(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$/.test(value);
}

export function WorkspaceAccessSettings() {
  const polish = useLanguage() === "pl";
  const [workspace, setWorkspace] = useState<{
    name?: string;
    id?: string;
    currentUser?: { userId: string; username: string; displayName: string; role: "owner" | "member" } | null;
    members?: Array<{ userId: string; username: string; displayName: string; role: "owner" | "member" }>;
  } | null>(null);
  const [serverName, setServerName] = useState("");
  const [serverPassword, setServerPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api("/api/workspace")
      .then((value) => { if (!alive) return; setWorkspace(value); setServerName(value.name ?? ""); })
      .catch((reason) => alive && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { alive = false; };
  }, []);

  const saveServer = async () => {
    // The name is one of the three values somebody types into another device,
    // so it has to be a slug — the same rule the server enforces. Slugify what
    // was typed (the helper this file already has), and only complain when even
    // that cannot be one.
    const name = slug(serverName).slice(0, 32).replace(/^-+|-+$/g, "");
    if (!isServerName(name)) {
      setError(polish
        ? "Nazwa serwera: 3–32 znaki, małe litery, cyfry i myślniki (nie na początku ani na końcu)."
        : "Server name: 3–32 characters, lowercase letters, digits and dashes (not at either end).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const value = await api("/api/server", { method: "PATCH", body: JSON.stringify({ name }) });
      setServerName(value.name ?? name);
      setWorkspace((current) => current ? { ...current, name: value.name } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  /** Rotating shows the new password once — the server only keeps its hash, so
   * there is no second chance to read it. */
  const rotatePassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = await api("/api/server/password", { method: "POST", body: "{}" });
      setServerPassword(String(value.serverPassword ?? ""));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const members = workspace?.members ?? [];
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Wspólny serwer" : "Shared server"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {polish ? "Każda osoba ma własne konto. Boty i sekcje są wspólne, prywatne boty mają osobne ACL." : "Each person has an account. Bots and sections are shared; private bots use their own ACL."}
      </div>
      {workspace?.currentUser && (
        <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">
          {workspace.currentUser.displayName || workspace.currentUser.username}
          <span className="ml-2 text-ink">· {workspace.currentUser.role}</span>
        </div>
      )}
      {members.length > 0 && (
        <div className="mt-3 space-y-1 text-[12px] text-ink-secondary">
          {members.map((member) => (
            <div key={member.userId} className="flex items-center justify-between gap-2">
              <span className="truncate">{member.displayName || member.username}</span>
              <span className="shrink-0">{member.role}</span>
            </div>
          ))}
        </div>
      )}
      {workspace?.currentUser?.role === "owner" && (
        <div className="mt-3 space-y-2">
          <input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder={polish ? "Nazwa serwera (np. brave-otter)" : "Server name (e.g. brave-otter)"} className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void saveServer()} disabled={busy} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
              {busy ? polish ? "Zapisywanie…" : "Saving…" : polish ? "Zapisz nazwę serwera" : "Save server name"}
            </button>
            <button type="button" onClick={() => void rotatePassword()} disabled={busy} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
              {polish ? "Nowe hasło serwera" : "New server password"}
            </button>
          </div>
          {serverPassword && (
            <div className="rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">
              <div>{polish ? "Nowe hasło serwera — pokazujemy je tylko raz:" : "New server password — shown only once:"}</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="select-all break-all text-[13px] text-ink">{serverPassword}</code>
                <button type="button" title={polish ? "Kopiuj" : "Copy"} onClick={() => void navigator.clipboard?.writeText(serverPassword)} className="shrink-0 text-ink-secondary hover:text-ink">
                  <Copy size={12} />
                </button>
              </div>
              <div className="mt-1">{polish ? "Stare hasło już nie działa — urządzenia dołączają nowym." : "The old password no longer works; devices join with this one."}</div>
            </div>
          )}
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

interface CustomModel {
  id: string;
  displayName: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

function readCustomModel(value: any): CustomModel {
  const model = value?.model;
  return {
    id: String(value?.id ?? ""),
    displayName: String(value?.displayName ?? value?.name ?? value?.id ?? "Custom model"),
    baseUrl: String(value?.baseUrl ?? value?.base_url ?? model?.baseUrl ?? model?.base_url ?? ""),
    model: String(value?.modelId ?? (typeof model === "string" ? model : model?.default) ?? value?.defaultModel ?? ""),
    hasKey: Boolean(value?.hasKey ?? value?.configured ?? value?.keyConfigured),
  };
}

function CustomModels() {
  const { dispatch } = useStore();
  const [models, setModels] = useState<CustomModel[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { reachable: boolean; tools: string; error?: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const polish = useLanguage() === "pl";
  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  const reload = () =>
    api("/api/models/custom")
      .then((body) => {
        const rows = Array.isArray(body) ? body : body.models ?? [];
        setModels(rows.map(readCustomModel).filter((item: CustomModel) => item.id));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    reload();
    // one load per panel mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshInstances = () =>
    api("/api/instances")
      .then(({ instances }) => dispatch({ type: "instances", instances }))
      .catch(() => {});

  const save = () => {
    const name = displayName.trim();
    const url = baseUrl.trim();
    const modelId = model.trim();
    if (busy || !name || !url || !modelId) return;
    setBusy(true);
    setError(null);
    const id = slug(name);
    api(`/api/models/custom/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ displayName: name, baseUrl: url, model: modelId, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
    })
      .then(() => {
        setDisplayName("");
        setBaseUrl("");
        setModel("");
        setApiKey("");
        reload();
        refreshInstances();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const remove = (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api(`/api/models/custom/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then(() => {
        setModels((items) => items.filter((item) => item.id !== id));
        refreshInstances();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const probe = (id: string) => {
    setChecking(id);
    api(`/api/models/custom/${encodeURIComponent(id)}/probe`, { method: "POST" })
      .then((result) => setChecks((current) => ({ ...current, [id]: result })))
      .catch((e) => setChecks((current) => ({ ...current, [id]: { reachable: false, tools: "unknown", error: String(e) } })))
      .finally(() => setChecking(null));
  };

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Modele" : "Models"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {polish ? "Adres zgodny z OpenAI. Lokalne Ollama, vLLM i LM Studio nie wymagają klucza." : "OpenAI-compatible URL. Local Ollama, vLLM and LM Studio need no key."}
      </div>
      {models.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {models.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg bg-inset px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-ink">{item.displayName}</div>
                <div className="truncate text-[11px] text-ink-secondary">
                  {item.model} · {item.baseUrl} · {item.hasKey ? polish ? "klucz zapisany" : "key saved" : polish ? "brak klucza" : "no key"}
                </div>
                {checks[item.id] && (
                  <div className="text-[11px] text-ink-secondary">
                    {checks[item.id].reachable ? polish ? "endpoint OK" : "endpoint OK" : polish ? "endpoint niedostępny" : "endpoint unavailable"} · {polish ? "narzędzia" : "tools"} {checks[item.id].tools}
                  </div>
                )}
              </div>
              <button
                aria-label={`${polish ? "Sprawdź" : "Check"} ${item.displayName}`}
                onClick={() => probe(item.id)}
                disabled={checking !== null}
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              >
                {checking === item.id ? <Loader2 size={13} className="animate-spin" /> : polish ? "Sprawdź" : "Check"}
              </button>
              <button
                aria-label={`${polish ? "Usuń" : "Remove"} ${item.displayName}`}
                onClick={() => remove(item.id)}
                className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex gap-2">
          {["Ollama|http://localhost:11434/v1", "vLLM|http://localhost:8000/v1", "LM Studio|http://localhost:1234/v1"].map((preset) => {
            const [label, url] = preset.split("|");
            return <button key={label} onClick={() => { setDisplayName(label); setBaseUrl(url); }} className="rounded-lg bg-raised px-2.5 py-1.5 text-[12px] text-ink-secondary hover:text-ink">{label}</button>;
          })}
        </div>
        <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={polish ? "Nazwa" : "Name"} />
        <input className={inputClass} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL · https://…/v1" />
        <input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder={polish ? "Identyfikator modelu · local/model" : "Model id · local/model"} />
        <div className="flex gap-2">
          <input
            type="password"
            className={inputClass}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={polish ? "Klucz API (opcjonalny lokalnie)" : "API key (optional for local)"}
            autoComplete="off"
          />
          <button
            onClick={save}
            disabled={busy || !displayName.trim() || !baseUrl.trim() || !model.trim()}
            className="flex w-[78px] shrink-0 items-center justify-center gap-1 rounded-lg bg-raised px-2 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Plus size={13} />{polish ? "Dodaj" : "Add"}</>}
          </button>
        </div>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

function CommandLineTools() {
  type CliRow = { id: string; displayName: string; enabled: boolean; detected: boolean; authenticated?: boolean; reason?: string; version?: string; installCommand?: string | null; loginCommand?: string | null; loginAvailable?: boolean; loginMode?: "stdin" | "device"; loginHint?: string };
  type LoginSession = { toolId: string; jobId: string; output: string[]; done: boolean; mode: "stdin" | "device"; error?: string };
  type InstallSession = { toolId: string; jobId: string; output: string[]; done: boolean; error?: string };
  const [cli, setCli] = useState<CliRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installJob, setInstallJob] = useState<InstallSession | null>(null);
  const [login, setLogin] = useState<LoginSession | null>(null);
  const [loading, setLoading] = useState(true);
  const polish = useLanguage() === "pl";
  const deviceLogin = (() => {
    if (login?.mode !== "device") return null;
    const output = login.output.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    return {
      url: output.match(/https?:\/\/[^\s<>"']+/)?.[0],
      code: output.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/)?.[0],
    };
  })();

  useEffect(() => {
    void api("/api/cli-tools").then(({ tools }) => setCli(tools)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const toggle = (tool: CliRow) => {
    setBusy(tool.id);
    void api(`/api/cli-tools/${encodeURIComponent(tool.id)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !tool.enabled }),
    })
      .then(({ tool: saved }) => setCli((items) => items.map((item) => item.id === saved.id ? saved : item)))
      .finally(() => setBusy(null));
  };

  const followLogin = async (jobId: string, toolId: string) => {
    const response = await authFetch(`/api/progress/${encodeURIComponent(jobId)}`);
    if (!response.ok || !response.body) throw new Error(`Login stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const part = await reader.read();
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as { output?: string[]; done: boolean; error?: string };
        setLogin((current) => current?.jobId === jobId
          ? { ...current, toolId, output: event.output ?? current.output, done: event.done || Boolean(event.error), error: event.error }
          : current);
      }
      if (part.done) break;
    }
  };

  const startLogin = async (tool: CliRow) => {
    if (login) return;
    try {
      const response = await api(`/api/cli-tools/${encodeURIComponent(tool.id)}/login`, { method: "POST" });
      const session: LoginSession = { toolId: tool.id, jobId: response.id, output: response.job?.output ?? [], done: false, mode: tool.loginMode ?? "stdin" };
      setLogin(session);
      await followLogin(response.id, tool.id);
      const refreshed = await api("/api/cli-tools").catch(() => ({ tools: [] }));
      setCli(refreshed.tools ?? []);
    } catch (error) {
      setLogin((current) => current ? { ...current, done: true, error: error instanceof Error ? error.message : String(error) } : null);
    }
  };

  const sendLoginInput = async (text: string) => {
    if (!login || !text.trim()) return;
    await api(`/api/progress/${encodeURIComponent(login.jobId)}/input`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  };

  const stopLogin = async () => {
    if (!login) return;
    await api(`/api/progress/${encodeURIComponent(login.jobId)}/stop`, { method: "POST" }).catch(() => {});
  };

  const closeLogin = () => setLogin(null);

  const followInstall = async (jobId: string, toolId: string) => {
    const response = await authFetch(`/api/progress/${encodeURIComponent(jobId)}`);
    if (!response.ok || !response.body) throw new Error(`Install stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let failure: string | undefined;
    for (;;) {
      const part = await reader.read();
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as { output?: string[]; done: boolean; error?: string };
        failure = event.error ?? failure;
        setInstallJob((current) => current?.jobId === jobId
          ? { ...current, toolId, output: event.output ?? current.output, done: event.done || Boolean(event.error), error: event.error }
          : current);
      }
      if (part.done) break;
    }
    return failure;
  };

  const install = async (tool: (typeof cli)[number]) => {
    if (installing) return;
    setInstalling(tool.id);
    try {
      const response = await api(`/api/cli-tools/${encodeURIComponent(tool.id)}/install`, { method: "POST" });
      setInstallJob({
        toolId: tool.id,
        jobId: response.id,
        output: response.job?.output ?? [],
        done: response.job?.status !== "running",
        error: response.job?.error,
      });
      const failure = await followInstall(response.id, tool.id);
      if (!failure) {
        const refreshed = await api("/api/cli-tools").catch(() => ({ tools: [] }));
        setCli(refreshed.tools ?? []);
        const installedTool = (refreshed.tools ?? []).find((item: CliRow) => item.id === tool.id);
        if (installedTool?.detected && installedTool.loginAvailable && !installedTool.authenticated) {
          void startLogin(installedTool);
        }
      }
    } catch (error) {
      setInstallJob((current) => current?.toolId === tool.id
        ? { ...current, done: true, error: error instanceof Error ? error.message : String(error) }
        : { toolId: tool.id, jobId: "", output: [], done: true, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setInstalling(null);
      const refreshed = await api("/api/cli-tools").catch(() => ({ tools: [] }));
      setCli(refreshed.tools ?? []);
    }
  };

  return (
    <>
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Narzędzia CLI" : "Command-line tools"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Pozwól botom korzystać z narzędzi na tym urządzeniu." : "Allow tools that can run bots on this device."}</div>
      <div className="mt-3 flex flex-col gap-1">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" />
            {polish ? "Sprawdzanie narzędzi…" : "Checking for tools…"}
          </div>
        ) : cli.length === 0 ? (
          <div className="py-2 text-[13px] text-danger">{polish ? "Nie wykryto narzędzi CLI." : "No command-line tools detected."}</div>
        ) : cli.map((item) => (
          <div key={item.id}>
            <div className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-raised/60">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-ink">{item.displayName}</div>
                <div className="truncate text-[11px] text-ink-secondary">
                  {item.detected
                    ? `${item.version ?? (polish ? "Wykryto" : "Detected")}${item.authenticated ? (polish ? " · zalogowano" : " · signed in") : item.loginCommand ? ` · ${polish ? "logowanie" : "sign in"}: ${item.loginCommand}` : ""}`
                    : item.reason ?? (polish ? "Nie wykryto" : "Not detected")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!item.detected && item.installCommand && <button
                  onClick={() => void install(item)}
                  disabled={installing !== null}
                  className="rounded-md bg-raised px-2 py-1 text-[11px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >{installing === item.id ? (polish ? "Instalowanie…" : "Installing…") : installJob?.toolId === item.id && installJob.error ? (polish ? "Spróbuj ponownie" : "Retry install") : polish ? "Zainstaluj" : "Install"}</button>}
                {item.detected && item.loginAvailable && !item.authenticated && <button
                  onClick={() => void startLogin(item)}
                  disabled={login !== null || !item.detected}
                  className="rounded-md bg-raised px-2 py-1 text-[11px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >{polish ? "Zaloguj" : "Sign in"}</button>}
                <input
                  aria-label={`${polish ? "Włącz" : "Enable"} ${item.displayName}`}
                  type="checkbox"
                  checked={item.enabled}
                  disabled={busy === item.id}
                  onChange={() => toggle(item)}
                  className="size-4 accent-[var(--color-accent)]"
                />
              </div>
            </div>
            {installJob?.toolId === item.id && (
              <div className="mx-2 mb-2 rounded-lg bg-inset p-2">
                <div className="mb-1 text-[11px] text-ink-secondary">
                  {installJob.done ? (installJob.error ? (polish ? "Instalacja nieudana." : "Installation failed.") : (polish ? "Instalacja zakończona. Odświeżam wykrywanie…" : "Installation finished. Refreshing detection…")) : (polish ? "Instalacja trwa; możesz wrócić później." : "Installation running; keep this panel open or return later.")}
                </div>
                {installJob.error && <div className="mt-1 text-[11px] text-danger">{installJob.error}</div>}
                <details className="mt-1 text-[11px] text-ink-secondary">
                  <summary className="cursor-pointer">{polish ? "Szczegóły techniczne" : "Technical details"}</summary>
                  <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap text-ink">{installJob.output.join("\n")}</pre>
                </details>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
    {login && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="presentation">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cli-login-title"
          className="w-full max-w-xl rounded-2xl border border-hairline/40 bg-card p-5 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div id="cli-login-title" className="text-[16px] font-semibold text-ink">{polish ? "Logowanie:" : "Sign in"} {cli.find((item) => item.id === login.toolId)?.displayName ?? login.toolId}</div>
              <div className="mt-1 text-[12px] text-ink-secondary">
                {login.mode === "device"
                  ? polish ? "Otwórz link, wpisz kod w przeglądarce. To okno zakończy się automatycznie." : "Open link below and enter shown code in browser. This window will finish automatically."
                  : cli.find((item) => item.id === login.toolId)?.loginHint ?? (polish ? "Wykonaj kroki pokazane przez oficjalne CLI." : "Follow the official CLI prompts.")}
              </div>
            </div>
            {login.done && <button onClick={closeLogin} className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised">{polish ? "Zamknij" : "Close"}</button>}
          </div>
          {login.mode === "device" ? (
            <div className="mt-4 rounded-xl bg-inset p-4">
              {deviceLogin?.url ? (
                <a href={deviceLogin.url} target="_blank" rel="noreferrer" className="block break-all text-[13px] text-accent underline">
                  {deviceLogin.url}
                </a>
              ) : <div className="text-[12px] text-ink-secondary">{polish ? "Przygotowuję bezpieczny link…" : "Preparing secure sign-in link…"}</div>}
              {deviceLogin?.code && (
                <div className="mt-4">
                  <div className="text-[11px] uppercase tracking-wide text-ink-secondary">{polish ? "Kod jednorazowy" : "One-time code"}</div>
                  <div className="mt-1 select-all font-mono text-[24px] font-semibold tracking-wider text-ink">{deviceLogin.code}</div>
                </div>
              )}
              {login.error && (
                <details className="mt-3 text-[11px] text-ink-secondary">
                    <summary className="cursor-pointer">{polish ? "Szczegóły techniczne" : "Technical details"}</summary>
                  <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap text-ink">{login.output.join("\n")}</pre>
                </details>
              )}
            </div>
          ) : (
            <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-inset p-3 text-[12px] leading-5 text-ink">{login.output.join("\n") || "Starting sign-in…"}</pre>
          )}
          {!login.done && (
            <div className="mt-3 flex gap-2">
              {login.mode !== "device" && <input
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink"
                placeholder={login.toolId === "claude" ? (polish ? "Wklej kod OAuth" : "Paste OAuth code") : polish ? "Odpowiedz CLI" : "Answer CLI prompt"}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const input = event.currentTarget;
                  void sendLoginInput(input.value).then(() => { input.value = ""; });
                }}
              />}
              <button onClick={() => void stopLogin()} className="rounded-lg bg-raised px-3 py-2 text-[12px] text-ink">{polish ? "Zatrzymaj" : "Stop"}</button>
            </div>
          )}
          {login.error && <div className="mt-2 text-[12px] text-danger">{login.error}</div>}
          {login.done && !login.error && <div className="mt-2 text-[12px] text-success">{polish ? "Zalogowano. Możesz zamknąć okno." : "Signed in. You can close this window."}</div>}
        </div>
      </div>
    )}
    </>
  );
}

/** Manual update check row — packaged app only (no bridge in dev). */
function UpdatesRow() {
  const s = useUpdaterState();
  const polish = useLanguage() === "pl";
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    window.ogb?.updater
      ?.currentVersion()
      .then((v) => {
        if (alive) setCurrentVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? polish ? "Sprawdzanie…" : "Checking…"
      : s?.status === "available"
        ? `${s.version} ${polish ? "dostępna" : "available"}`
        : s?.status === "downloading"
          ? `${polish ? "Pobieranie…" : "Downloading…"} ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ${polish ? "gotowa — uruchom ponownie" : "ready — restart to apply"}`
            : s?.status === "error"
              ? `${polish ? "Sprawdzenie nieudane" : "Check failed"}: ${s.message ?? (polish ? "nieznany błąd" : "unknown error")}`
              : polish ? "Masz najnowszą znaną wersję." : "You're on the latest version we know of.";
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Aktualizacje aplikacji" : "App updates"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {polish ? "Bieżąca wersja" : "Current version"}: <span className="font-medium text-ink">{currentVersion ?? "…"}</span>
      </div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{label}</div>
      <div className="mt-3 flex gap-2">
        {s?.status === "available" ? (
          <button
            onClick={() => void updater.download()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            {polish ? "Pobierz" : "Download"}
          </button>
        ) : s?.status === "downloaded" ? (
          <button
            onClick={() => void updater.install()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            {polish ? "Uruchom ponownie, aby zaktualizować" : "Restart to update"}
          </button>
        ) : (
          <button
            onClick={() => void updater.check()}
            disabled={s?.status === "checking" || s?.status === "downloading"}
            className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
          >
            Check for updates
          </button>
        )}
      </div>
    </div>
  );
}

// multibot: banerka systemowa, gdy bot skończy albo prosi o decyzję. Ustawienie
// jest lokalne dla tej powłoki (jak tryb animacji), bo dotyczy tego urządzenia,
// nie konta. Zgody przeglądarki pytamy raz, dopiero przy włączeniu.
function DesktopNotificationsRow({ polish }: { polish: boolean }) {
  const [enabled, setEnabled] = useState(() => readDesktopNotifications());
  const label = polish ? "Powiadomienia na pulpicie" : "Desktop notifications";
  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    setDesktopNotifications(next);
    if (next) void requestBrowserNotifications();
  };

  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
      <div>
        <div className="text-[15px] font-medium text-ink">{label}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {polish
            ? "Gdy bot skończy odpowiedź, prosi o decyzję albo pokój współpracy zamknie temat. Kliknięcie otwiera tego bota."
            : "When a bot finishes, asks for a decision, or a collab room wraps up. Clicking opens that bot."}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        onClick={toggle}
        className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", enabled ? "bg-accent" : "bg-raised")}
      >
        <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-[left]", enabled ? "left-[21px]" : "left-[3px]")} />
      </button>
    </div>
  );
}

function MotionSettings({ polish }: { polish: boolean }) {
  const [mode, setMode] = useState<MotionMode>(() => readMotionMode());
  const enabled = mode === "full";
  const toggle = () => {
    const next: MotionMode = enabled ? "reduced" : "full";
    applyMotionMode(next);
    setMode(next);
  };

  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
      <div>
        <div className="text-[15px] font-medium text-ink">{polish ? "Animacje interfejsu" : "Interface animations"}</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {polish ? "Ruch maskotek, ikon ustawień i menu." : "Mascot, settings icon, and menu motion."}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={polish ? "Animacje interfejsu" : "Interface animations"}
        onClick={toggle}
        className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", enabled ? "bg-accent" : "bg-raised")}
      >
        <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-[left]", enabled ? "left-[21px]" : "left-[3px]")} />
      </button>
    </div>
  );
}

// multibot: akceleracja sprzętowa. Domyślnie WYŁĄCZONA (Kacper 29.08).
// Electron rozstrzyga ją przed gotowością aplikacji, więc przełącznik tylko
// zapisuje preferencję — działa dopiero po restarcie i tak to podpisujemy.
// Widoczny wyłącznie na pulpicie: w przeglądarce nie ma czego przełączać,
// więc w karcie System zostaje wtedy sam mikrofon.
function HardwareAccelerationRow({ polish }: { polish: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [gpuActive, setGpuActive] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const hardware = window.ogb?.hardwareAcceleration;
    hardware
      ?.get()
      .then((value) => alive && setEnabled(value === true))
      .catch(() => alive && setEnabled(false));
    hardware
      ?.status?.()
      .then((value) => alive && setGpuActive(value.active === true))
      .catch(() => alive && setGpuActive(null));
    return () => {
      alive = false;
    };
  }, []);

  if (!isElectron || !window.ogb?.hardwareAcceleration) return null;

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    // Cofamy przełącznik, gdy zapis padnie — inaczej panel pokazywałby stan,
    // którego nie ma na dysku, i restart cicho by go wycofał.
    window.ogb?.hardwareAcceleration?.set(next).catch(() => setEnabled(!next));
  };

  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
      <div>
        <div className="text-[15px] font-medium text-ink">
          {polish ? "Używaj akceleracji sprzętowej" : "Use hardware acceleration"}
        </div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {polish
            ? "Rysowanie interfejsu przez kartę graficzną. Zmiana zadziała po ponownym uruchomieniu aplikacji."
            : "Render the interface on the GPU. Takes effect after you restart the app."}
        </div>
        <div className="mt-1 text-[12px] text-ink-secondary">
          {gpuActive === true
            ? polish ? "GPU aktywne teraz" : "GPU active now"
            : enabled
              ? polish ? "GPU włączy się przy następnym uruchomieniu" : "GPU will be used after the next restart"
              : polish ? "GPU wyłączone" : "GPU disabled"}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={polish ? "Używaj akceleracji sprzętowej" : "Use hardware acceleration"}
        onClick={toggle}
        className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", enabled ? "bg-accent" : "bg-raised")}
      >
        <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-[left]", enabled ? "left-[21px]" : "left-[3px]")} />
      </button>
    </div>
  );
}
const settingsTabs = [
  {
    id: "general",
    Icon: SlidersTabIcon,
    pl: "Ogólne",
    en: "General",
    descriptionPl: "Język, profil, wygląd i połączenia.",
    descriptionEn: "Language, profile, appearance, and connections.",
  },
  {
    id: "other",
    Icon: WrenchTabIcon,
    pl: "Narzędzia",
    en: "Tools",
    descriptionPl: "Dostęp, modele, usługa lokalna i diagnostyka.",
    descriptionEn: "Access, models, local service, and diagnostics.",
  },
  {
    id: "update",
    Icon: RefreshTabIcon,
    pl: "Aktualizacje",
    en: "Updates",
    descriptionPl: "Sprawdź i zainstaluj aktualizacje aplikacji.",
    descriptionEn: "Check for and install app updates.",
  },
] as const;
type AppSettingsTab = (typeof settingsTabs)[number]["id"];

export function AppSettingsPanel() {
  const { dispatch } = useStore();
  const language = useLanguage();
  const polish = language === "pl";
  const [tab, setTab] = useState<AppSettingsTab>("general");
  // multibot: licznik kliknięć w szynę sekcji. Sam `tab` nie wystarczy —
  // ponowne kliknięcie w już wybraną ikonę nie zmienia stanu, więc animacja
  // nie miałaby czego odtworzyć. Numer idzie do `key`, co przemontowuje
  // warstwę błysku i puszcza ją od nowa.
  const [press, setPress] = useState<{ tab: AppSettingsTab; nth: number }>({ tab: "general", nth: 0 });
  const currentTab = settingsTabs.find((item) => item.id === tab) ?? settingsTabs[0];

  return (
    <main className="app-settings-screen animate-panel-in flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      <header data-shell-header className="flex shrink-0 items-center gap-3 border-b border-hairline/40 bg-panel py-4 pr-6 lg:pr-10">
        {/* multibot: back w jednej osi z ikonami szyny sekcji pod spodem —
            ta sama 72px szerokość kolumny, żeby strzałka nie wisiała inaczej
            niż przyciski sekcji (Kacper 28.08). */}
        <div className="flex w-[72px] shrink-0 items-center justify-center">
          <button
            onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
            className="rounded-lg p-2.5 text-ink-secondary transition-colors hover:bg-raised hover:text-ink"
            title={polish ? "Wróć" : "Back"}
            aria-label={polish ? "Wróć" : "Back"}
          >
            <ArrowLeft size={18} />
          </button>
        </div>
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">{polish ? "Ustawienia aplikacji" : "App Settings"}</h1>
          <p className="mt-1 text-[13px] text-ink-secondary">{polish ? "Konfiguracja wspólna dla całego MultiBota." : "Settings shared across your MultiBot workspace."}</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={polish ? "Sekcje ustawień" : "Settings sections"}
          className="flex w-[72px] shrink-0 flex-col items-center gap-2 border-r border-hairline/40 bg-panel px-2 py-5"
        >
          {settingsTabs.map(({ id, Icon, pl, en }) => {
            const label = polish ? pl : en;
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                data-settings-tab
                onClick={() => {
                  setTab(id);
                  setPress((p) => ({ tab: id, nth: p.tab === id ? p.nth + 1 : 0 }));
                }}
                title={label}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // multibot: wciśnięcie zjeżdża do 92% — w dół, nigdy w górę,
                  // więc przycisk nie wychodzi poza swoje miejsce w szynie.
                  // Żadnej kolorowej nakładki na kafelku: na kliknięcie rusza
                  // się wnętrze ikony, a nie tło pod nią (Kacper 28.08).
                   "relative flex size-10 items-center justify-center rounded-lg",
                  "transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.92]",
                  "before:absolute before:left-0 before:h-5 before:w-0.5 before:rounded-full",
                  active
                    ? "bg-raised text-accent before:bg-accent"
                    : "text-ink-secondary hover:bg-raised/70 hover:text-ink before:bg-transparent",
                )}
              >
                {/* key = numer kliknięcia: przemontowanie puszcza animację od
                    nowa, także gdy klikniesz w już wybraną sekcję */}
                <Icon key={press.nth} size={19} playing={press.tab === id} />
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-6 py-7 lg:px-10">
            <div className="mb-6">
              <h2 className="text-[22px] font-semibold tracking-[-0.025em] text-ink">{polish ? currentTab.pl : currentTab.en}</h2>
              <p className="mt-1 text-[13px] text-ink-secondary">{polish ? currentTab.descriptionPl : currentTab.descriptionEn}</p>
            </div>
          {tab === "general" && (
            <>
              <div className="mt-2 flex items-center justify-between gap-4 rounded-xl bg-card p-4">
                <div>
                  <div className="text-[15px] font-medium text-ink">{polish ? "Język" : "Language"}</div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Wybierz język aplikacji." : "Choose app language."}</div>
                </div>
                <select
                  value={language}
                  onChange={(event) => setLanguage(event.target.value as Language)}
                  className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink focus:outline-none"
                  aria-label={polish ? "Język" : "Language"}
                >
                  <option value="en">{languageLabel("en")}</option>
                  <option value="pl">{languageLabel("pl")}</option>
                </select>
              </div>
              <div className="mt-2 rounded-xl bg-card p-4">
                <div className="text-[15px] font-medium text-ink">{polish ? "Profil" : "Profile"}</div>
                <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Widoczny na pasku bocznym. Zapisuje się automatycznie." : "Shown in the sidebar. Saved as you go."}</div>
                <div className="mt-4">
                  <ProfileFields />
                </div>
              </div>
              {/* multibot: System — ustawienia samej aplikacji, nie komputera.
                  Mikrofon mowi, z ktorego wejscia nagrywa MultiBot; akceleracja
                  dotyczy wylacznie okna tej aplikacji (Kacper 29.08). */}
              <div className="mt-4 rounded-xl bg-card p-4">
                <div className="text-[15px] font-medium text-ink">System</div>
                <div className="mt-4">
                  <MicrophoneRow polish={polish} />
                </div>
                <DesktopNotificationsRow polish={polish} />
                <HardwareAccelerationRow polish={polish} />
              </div>
              <BotSettingsCard polish={polish} />
              <div className="mt-4 rounded-xl bg-card p-4">
                <div className="text-[15px] font-medium text-ink">{polish ? "Skórka" : "Skin"}</div>
                <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Kolory interfejsu zapisują się lokalnie." : "Interface colors are stored locally."}</div>
                <div className="mt-3"><SkinPicker /></div>
                <MotionSettings polish={polish} />
              </div>

              <div className="mt-4 rounded-xl bg-card p-4">
                <div className="text-[15px] font-medium text-ink">{polish ? "Połączenia" : "Connections"}</div>
                <div className="mt-0.5 text-[13px] text-ink-secondary">
                  {polish
                    ? "Wspólne dla wszystkich botów. Zapis klucza od razu przeładowuje dostawców; klucze zostają lokalnie i nie są ponownie wyświetlane."
                    : "Shared by all bots. Saving a key reloads providers instantly; keys are stored locally and never shown again."}
                </div>
                <div className="mt-4 flex flex-col gap-4">
                  <ApiKeyRow
                    section="opencode"
                    label="OpenCode Go API key"
                    placeholder="Wklej klucz OpenCode Go"
                  />
                  <ApiKeyRow section="composio" label="Composio Connect key" placeholder="ck_…" />
                  <ApiKeyRow
                    section="composioApi"
                    label="Composio API key (optional)"
                    placeholder="ak_…  unlocks the full app catalog"
                  />
                  {/* multibot (A5): box.ascii.dev usunięty z rejestracji driverów — pole tokena martwe, więc go nie ma */}
                </div>
              </div>
            </>
          )}

          {tab === "update" && (
            <UpdatesRow />
          )}

          {tab === "other" && (
            <>
              {/* multibot: G1 — custom model catalog lives at app level, never per bot. */}
              <CustomModels />
              {/* multibot: G1 — CLI allowlist UI; provisioning actions land in G3. */}
              <CommandLineTools />

              <MachineResources />
              <DiagnosticsRow />
            </>
          )}
          </div>
        </div>
      </div>
    </main>
  );
}
