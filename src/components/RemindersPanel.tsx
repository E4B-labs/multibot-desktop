// multibot: panel przypomnień — druga zakładka prawego slotu, obok rutyn
// (Kacper, 10.09.2026). Przypomnienie NIE jest rutyną: ma jedną chwilę, odpala
// raz i zostaje na liście jako odpalone.
//
// Lista jest CAŁEGO warsztatu, nie jednego bota: człowiek prosi „przypomnij mi
// o X" różne boty i chce jednego spisu. Stąd pigułka z awatarem przy każdym
// wierszu — mówi, kto przypomni.
//
// Kolejność rozstrzyga serwer (`Reminders.list`): najbliższe najpierw, odpalone
// na końcu. Klient jej nie sortuje, żeby pulpit i telefon nie rozjechały się
// przy tej samej liście.
import { useEffect, useState } from "react";
import { Bell, Clock, Loader2, Trash2, X } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { relativeTime } from "@/lib/relativeTime";

export interface ReminderRecord {
  id: string;
  botId: string;
  text: string;
  at: string;
  createdAt: string;
  firedAt: string | null;
  status: "pending" | "fired";
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** Data i godzina w strefie i formacie czytelnika. Serwer oddaje pełny moment
 * ISO, więc nie ma tu zgadywania strefy. */
export function formatAt(at: string, polish: boolean): string {
  return new Intl.DateTimeFormat(polish ? "pl-PL" : "en-US", {
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

export function RemindersPanel() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [items, setItems] = useState<ReminderRecord[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Odświeżanie co minutę: „za 2 godz." musi się starzeć samo, inaczej otwarty
  // panel kłamie po kwadransie.
  const [, setNow] = useState(() => Date.now());

  const load = () =>
    api("/api/reminders").then((rs: ReminderRecord[]) => {
      setItems(rs);
      setStatus("ready");
    });

  useEffect(() => {
    load().catch(() => setStatus("offline"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.workspaceVersion]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const showError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const remove = (id: string) => {
    setBusy(`delete:${id}`);
    setError(null);
    api(`/api/reminders/${id}`, { method: "DELETE" })
      .then(() => setItems((rs) => rs.filter((r) => r.id !== id)))
      .catch(showError)
      .finally(() => setBusy(null));
  };

  const snooze = (id: string) => {
    setBusy(`snooze:${id}`);
    setError(null);
    api(`/api/reminders/${id}/snooze`, { method: "POST", body: JSON.stringify({ minutes: 60 }) })
      .then(() => load())
      .catch(showError)
      .finally(() => setBusy(null));
  };

  return (
    <aside className="animate-panel-in flex h-full w-[360px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div data-shell-header className="flex items-center justify-between px-4 py-3">
        <span className="w-[52px]" />
        <span className="text-[15px] font-semibold text-ink">{polish ? "Przypomnienia" : "Reminders"}</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => dispatch({ type: "toggleRoutines", open: false })}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label={polish ? "Zamknij" : "Close"}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Dwie zakładki jednego slotu — rutyna powtarza się, przypomnienie odpala raz */}
      <div className="flex gap-1 px-5 pb-3">
        <button
          onClick={() => dispatch({ type: "toggleRoutines", open: true, tab: "routines" })}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {polish ? "Rutyny" : "Routines"}
        </button>
        <button
          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink"
          aria-current="page"
        >
          {polish ? "Przypomnienia" : "Reminders"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {status === "offline" ? (
          <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className="size-1.5 rounded-full bg-raised-hover" />
            {polish ? "Serwer nie odpowiada" : "Service offline"}
          </div>
        ) : status === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> {polish ? "Wczytuję…" : "Loading reminders…"}
          </div>
        ) : items.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
            <Bell size={22} />
            <div className="text-[13px] font-medium text-ink">{polish ? "Brak przypomnień" : "No reminders yet"}</div>
            <span className="text-[12px]">
              {polish
                ? "Poproś bota: „przypomnij mi jutro o 9 o dentyście”. Przypomnienie odpali raz i przyjdzie powiadomieniem na telefon."
                : "Ask a bot: “remind me about the dentist tomorrow at 9”. A reminder fires once and arrives as a push on your phone."}
            </span>
          </div>
        ) : (
          items.map((r) => {
            const bot = state.bots.find((b) => b.id === r.botId);
            const fired = r.status === "fired";
            return (
              <div key={r.id} className={cn("mt-3 rounded-xl bg-card p-4", fired && "opacity-55")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 gap-2.5">
                    {bot ? (
                      <span className="mt-0.5 shrink-0">
                        <BotAvatar color={bot.color} avatarUrl={bot.avatarUrl} shape="blob" size={20} animated={false} />
                      </span>
                    ) : (
                      <Bell size={16} className="mt-1 shrink-0 text-ink-secondary" />
                    )}
                    <div className="min-w-0">
                      <div className="text-[15px] font-medium text-ink">{r.text}</div>
                      <div className="mt-0.5 text-[13px] text-ink-secondary">
                        {formatAt(r.at, polish)}
                        {bot && ` · ${bot.name}`}
                      </div>
                      <div className="mt-0.5 text-[12px] text-ink-secondary">
                        {fired
                          ? `${polish ? "Odpaliło" : "Fired"} ${relativeTime(Date.parse(r.firedAt ?? r.at), Date.now(), polish ? "pl" : "en")}`
                          : relativeTime(Date.parse(r.at), Date.now(), polish ? "pl" : "en")}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      onClick={() => snooze(r.id)}
                      disabled={busy === `snooze:${r.id}`}
                      className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                      title={polish ? "Odłóż o godzinę" : "Snooze 1 h"}
                      aria-label={polish ? "Odłóż o godzinę" : "Snooze 1 h"}
                    >
                      {busy === `snooze:${r.id}` ? <Loader2 size={15} className="animate-spin" /> : <Clock size={15} />}
                    </button>
                    <button
                      onClick={() => remove(r.id)}
                      disabled={busy === `delete:${r.id}`}
                      className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50"
                      title={polish ? "Usuń" : "Delete"}
                      aria-label={polish ? "Usuń" : "Delete"}
                    >
                      {busy === `delete:${r.id}` ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
      </div>
    </aside>
  );
}
