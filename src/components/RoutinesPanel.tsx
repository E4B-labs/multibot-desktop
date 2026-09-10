// multibot: wspólny panel rutyn ponad wszystkimi providerami. Harness owns
// schedules, then dispatches current provider at execution time.
// Harmonogram waliduje silnik (`parse_schedule`: "every 30m" / cron / ISO) —
// UI tylko składa string i pokazuje 422 z `detail`.
import { useEffect, useState } from "react";
import {
  CalendarClock,
  Check,
  ClipboardCopy,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { buildSchedule, isKnownPreset, parseSchedule, PRESETS, type Preset } from "@/lib/routineSchedule";

// Własny helper zamiast `api` ze store: silnik zwraca błędy jako `{detail}`
// (FastAPI), przelotka jako `{error}` — store'owy helper zgubiłby komunikat
// walidacji crona i pokazał gołe "422 Unprocessable Entity".
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    throw new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

/** Mirror of engine `_to_routine()` (engine/server/routines.py). */
interface Routine {
  id: string;
  name: string;
  schedule: string | null;
  prompt: string;
  enabled: boolean;
  trigger: { type: string; url: string; events: string[] } | null;
  last_runs: Array<{ at: string; status?: string | null; error?: string | null }>;
  next_run_at: number | null;
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[13px] text-ink-secondary">{children}</div>;
}

// Presety harmonogramu → stringi, które silnik parsuje sam ("every 1h" =
// interwał local service; daily/weekly/monthly = cron, dzień tygodnia 0-6 z
// niedzielą=0). Cztery presety, zero surowego crona w UI (Faza R1).
const MODE_LABELS: Record<Preset, string> = {
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_PREP_PL = ["w niedzielę", "w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę"];

const pad2 = (n: number) => String(n).padStart(2, "0");

// Human sentence for the card — never the raw cron/interval string. Unknown
// (unclassifiable legacy) schedules get a generic label instead of exposing
// the cron; `null` = manual routine (webhook/Run now only).
function scheduleSentence(schedule: string | null, polish: boolean): string {
  const parsed = parseSchedule(schedule);
  // multibot: przypomnienie — jedna data, nie powtarzalny harmonogram
  if (parsed.once) return `${polish ? "Przypomnienie" : "Reminder"} · ${formatNextRun(parsed.once, polish)}`;
  const at = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  switch (parsed.preset) {
    case "manual":
      return polish ? "Ręczna" : "Manual";
    case "hourly":
      return polish ? "Co godzinę" : "Every hour";
    case "daily":
      return polish ? `Codziennie o ${at}` : `Every day at ${at}`;
    case "weekly":
      return polish
        ? `Co tydzień ${WEEKDAY_PREP_PL[parsed.weekday]} o ${at}`
        : `Every week on ${WEEKDAYS[parsed.weekday]} at ${at}`;
    case "monthly":
      return polish ? `Co miesiąc, ${parsed.monthDay}. dnia, o ${at}` : `Every month on day ${parsed.monthDay} at ${at}`;
    default:
      return polish ? "Inny harmonogram" : "Other schedule";
  }
}

function formatNextRun(ts: number, polish: boolean): string {
  return new Intl.DateTimeFormat(polish ? "pl-PL" : "en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

// Manual routines have no next-run concept — only scheduled ones get a line.
function nextRunLine(r: Routine, polish: boolean): string | null {
  if (!r.schedule) return null;
  // przypomnienie bez następnego terminu już odpaliło — nie „jeszcze nie"
  if (!r.next_run_at) {
    return parseSchedule(r.schedule).once
      ? (polish ? "Już odpaliło" : "Already fired")
      : (polish ? "Jeszcze nie uruchomiono" : "Not run yet");
  }
  return `${polish ? "Następne uruchomienie" : "Next run"}: ${formatNextRun(r.next_run_at, polish)}`;
}

function RoutineForm({
  routinePath,
  routine,
  onSaved,
  onCancel,
}: {
  routinePath: string;
  /** null = create */
  routine: Routine | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const polish = useLanguage() === "pl";
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  // Edycja rozpoznaje preset po aktualnym harmonogramie (parser cron→preset,
  // Faza R1). Nierozpoznany/manualny harmonogram otwiera się na "daily" jako
  // rozsądnym domyślnym, ale nic nie wysyłamy, dopóki user faktycznie nie
  // dotknie harmonogramu — patrz `touched` niżej.
  const parsedInitial = parseSchedule(routine?.schedule ?? null);
  const [mode, setMode] = useState<Preset>(isKnownPreset(parsedInitial.preset) ? parsedInitial.preset : "daily");
  const [time, setTime] = useState(`${pad2(parsedInitial.hour)}:${pad2(parsedInitial.minute)}`);
  const [weekday, setWeekday] = useState(parsedInitial.weekday);
  const [monthDay, setMonthDay] = useState(parsedInitial.monthDay);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setTouched(true);
  };

  const computeSchedule = (): string | null => {
    // Untouched schedule on edit: keep it unchanged (PATCH omits `schedule`),
    // even for a recognized preset — rebuilding it here would reset the
    // harness's next-run anchor (`nextRun(schedule, now)`) on a name-only
    // edit, and would rewrite a legacy fixed-minute hourly cron ("15 * * * *")
    // into the fixed "every 1h" interval form (gate R1 item 5).
    if (routine && !touched) return null;
    const [h, m] = time.split(":");
    return buildSchedule(mode, { minute: +m, hour: +h, weekday, monthDay });
  };

  const save = () => {
    if (saving || !name.trim() || !prompt.trim()) return;
    setSaving(true);
    setError(null);
    const schedule = computeSchedule();
    const body = { name: name.trim(), prompt: prompt.trim(), ...(schedule ? { schedule } : {}) };
    (routine
      ? api(`${routinePath}/${routine.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : api(routinePath, {
          method: "POST",
          body: JSON.stringify(body),
        })
    )
      .then(onSaved)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">
        {routine ? (polish ? "Edytuj rutynę" : "Edit routine") : (polish ? "Nowa rutyna" : "New routine")}
      </div>

      <label className="block">
        <FieldLabel>{polish ? "Nazwa" : "Name"}</FieldLabel>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={polish ? "Poranny skrót" : "Morning digest"}
        />
      </label>

      <label className="block">
        <FieldLabel>{polish ? "Polecenie" : "Prompt"}</FieldLabel>
        <textarea
          className={cn(inputCls, "min-h-[96px] resize-none")}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={polish ? "Co bot ma robić przy każdym uruchomieniu?" : "What should the bot do each run?"}
        />
      </label>

      <div>
        <FieldLabel>{polish ? "Harmonogram" : "Schedule"}</FieldLabel>
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {PRESETS.map((m, i) => (
            <button
              key={m}
              onClick={() => touch(setMode)(m)}
              className={cn(
                "flex-1 py-1.5 text-[13px]",
                i > 0 && "border-l border-hairline/40",
                mode === m ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        {(mode === "daily" || mode === "weekly" || mode === "monthly") && (
          <div className="mt-2 flex gap-2">
            {mode === "weekly" && (
              <select
                className={inputCls}
                value={weekday}
                onChange={(e) => touch(setWeekday)(+e.target.value)}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            )}
            {mode === "monthly" && (
              <input
                type="number"
                min={1}
                max={31}
                className={inputCls}
                value={monthDay}
                onChange={(e) => touch(setMonthDay)(Math.min(31, Math.max(1, +e.target.value || 1)))}
              />
            )}
            <input
              type="time"
              className={inputCls}
              value={time}
              onChange={(e) => touch(setTime)(e.target.value)}
            />
          </div>
        )}
      </div>

      {error && <div className="text-[12px] text-danger">{error}</div>}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving || !name.trim() || !prompt.trim()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {routine ? (polish ? "Zapisz" : "Save") : (polish ? "Utwórz" : "Create")}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg bg-raised px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
        >
          {polish ? "Anuluj" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

export function RoutinesPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const routinePath = `/api/bots/${bot.id}/routines`;
  const [status, setStatus] = useState<"loading" | "offline" | "ready">("loading");
  const [routines, setRoutines] = useState<Routine[]>([]);
  // null = lista; "new" = create; Routine = edit
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "<action>:<rid>"
  const [ranId, setRanId] = useState<string | null>(null); // transient "Queued" po Run now
  const [error, setError] = useState<string | null>(null);
  // multibot (webhook): sekret z odpowiedzi `enable` pokazany TYLKO raz — nie
  // wraca w list(), więc jedyny moment, w którym może go zobaczyć, to ta
  // odpowiedź. Po zamknięciu (OK) znika na dobre.
  const [revealed, setRevealed] = useState<{ rid: string; url: string; secret: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null); // transient "Copied"

  const copy = (rid: string, value: string) => {
    void navigator.clipboard?.writeText(value);
    setCopied(rid);
    setTimeout(() => setCopied((cur) => (cur === rid ? null : cur)), 1500);
  };

  const load = () =>
    api(routinePath).then((rs: Routine[]) => {
      setRoutines(rs);
      setStatus("ready");
    });

  useEffect(() => {
    let alive = true;
    load()
      .catch(() => alive && setStatus("offline"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routinePath]);

  const showError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const runNow = (rid: string) => {
    setBusy(`run:${rid}`);
    setError(null);
    api(`${routinePath}/${rid}/run`, { method: "POST" })
      .then(() => {
        setRanId(rid);
        setTimeout(() => setRanId((cur) => (cur === rid ? null : cur)), 2500);
      })
      .catch(showError)
      .finally(() => setBusy(null));
  };

  // Bez dialogu potwierdzenia — wzorzec repo (Delete bota w Sidebar też jest
  // bezpośredni), destruktywność sygnalizuje styl danger.
  const remove = (rid: string) => {
    setBusy(`delete:${rid}`);
    setError(null);
    api(`${routinePath}/${rid}`, { method: "DELETE" })
      .then(() => setRoutines((rs) => rs.filter((r) => r.id !== rid)))
      .catch(showError)
      .finally(() => setBusy(null));
  };

  // multibot (webhook): włącz trigger webhooka rutyny. Odpowiedź niesie sekret
  // JEDEN raz — trzymamy go tylko w tym stanie, nigdy nie w list().
  const enableWebhook = (rid: string) => {
    setBusy(`webhook:${rid}`);
    setError(null);
    api(`${routinePath}/${rid}/webhook`, { method: "POST" })
      .then((hook: { url: string; secret: string }) => {
        setRevealed({ rid, url: hook.url, secret: hook.secret });
        load().catch(() => setStatus("offline"));
      })
      .catch(showError)
      .finally(() => setBusy(null));
  };


  const lastRunLine = (r: Routine) => {
    const run = r.last_runs[0];
    if (!run) return polish ? "Brak uruchomień" : "No runs yet";
    const when = new Date(run.at).toLocaleString();
    return run.error
      ? `${polish ? "Ostatnie uruchomienie" : "Last run"} ${when} — ${run.error}`
      : `${polish ? "Ostatnie uruchomienie" : "Last run"} ${when}${run.status ? ` — ${run.status}` : ""}`;
  };

  return (
    <aside className="animate-panel-in flex h-full w-[360px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div data-shell-header className="flex items-center justify-between px-4 py-3">
        <span className="w-[52px]" />
        <span className="text-[15px] font-semibold text-ink">{polish ? "Rutyny" : "Routines"}</span>
        {/* multibot: dodawanie rutyny siedzi w nagłówku sekcji, jak na projekcie */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setEditing("new")}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title={polish ? "Nowa rutyna" : "New routine"}
            aria-label={polish ? "Nowa rutyna" : "New routine"}
          >
            <Plus size={18} />
          </button>
          <button
            onClick={() => dispatch({ type: "toggleRoutines", open: false })}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Dwie zakładki jednego slotu — rutyna powtarza się, przypomnienie odpala raz */}
      <div className="flex gap-1 px-5 pb-3">
        <button className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink" aria-current="page">
          {polish ? "Rutyny" : "Routines"}
        </button>
        <button
          onClick={() => dispatch({ type: "toggleRoutines", open: true, tab: "reminders" })}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {polish ? "Przypomnienia" : "Reminders"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {status === "offline" ? (
          // Konwencja local runtime controls
          <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className="size-1.5 rounded-full bg-raised-hover" />
            Service offline
          </div>
        ) : status === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> Loading routines…
          </div>
        ) : editing !== null ? (
          <RoutineForm
            routinePath={routinePath}
            routine={editing === "new" ? null : editing}
            onSaved={() => {
              setEditing(null);
              load().catch(() => setStatus("offline"));
            }}
            onCancel={() => setEditing(null)}
          />
        ) : routines.length === 0 ? (
          // Empty state w konwencji pustych stanów panelu Computer
          <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
            <CalendarClock size={22} />
            <div className="text-[13px] font-medium text-ink">{polish ? "Brak rutyn" : "No routines yet"}</div>
            <span className="text-[12px]">
              Routines are recurring tasks this bot runs on a schedule — they run in the background
              even while the app is closed.
            </span>
            <button
              onClick={() => setEditing("new")}
              className="mt-2 rounded-lg bg-raised px-4 py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              Create Routine
            </button>
          </div>
        ) : (
          <>
            {/* multibot: dodawanie przeniesione do „+" w nagłówku sekcji */}
            {routines.map((r) => {
              return (
                <div key={r.id} className={cn("mt-3 rounded-xl bg-card p-4", parseSchedule(r.schedule).once && !r.next_run_at && "opacity-60")}>
                  <div className="flex items-start justify-between gap-2">
                    {/* multibot: wiersz z ikoną zegara po lewej — ten sam znak,
                        którym oznaczona jest rutyna w transkrypcie */}
                    <div className="flex min-w-0 gap-2.5">
                      <CalendarClock size={16} className="mt-1 shrink-0 text-ink-secondary" />
                      <div className="min-w-0">
                      <div className="truncate text-[15px] font-medium text-ink">{r.name || r.id}</div>
                      <div className="mt-0.5 text-[13px] text-ink-secondary">
                        {scheduleSentence(r.schedule, polish)}
                        {!r.enabled && ` · ${polish ? "wyłączona" : "disabled"}`}
                      </div>
                      {nextRunLine(r, polish) && (
                        <div className="mt-0.5 text-[12px] text-ink-secondary">{nextRunLine(r, polish)}</div>
                      )}
                      <div className="mt-0.5 truncate text-[12px] text-ink-secondary" title={lastRunLine(r)}>
                        {lastRunLine(r)}
                      </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => runNow(r.id)}
                        disabled={busy === `run:${r.id}`}
                        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                        title={polish ? "Uruchom teraz (w ciągu minuty)" : "Run now (fires within a minute)"}
                      >
                        {busy === `run:${r.id}` ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : ranId === r.id ? (
                          <Check size={15} className="text-success" />
                        ) : (
                          <Play size={15} />
                        )}
                      </button>
                      <button
                        onClick={() => setEditing(r)}
                        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                        title={polish ? "Edytuj" : "Edit"}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => remove(r.id)}
                        disabled={busy === `delete:${r.id}`}
                        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50"
                        title={polish ? "Usuń" : "Delete"}
                      >
                        {busy === `delete:${r.id}` ? (
                          <Loader2 size={15} className="animate-spin" />
                        ) : (
                          <Trash2 size={15} />
                        )}
                      </button>
                      {/* multibot (webhook): trigger dla rutyn CLI — włączany
                          przyciskiem; po włączeniu karta pokazuje adres */}
                      {!r.trigger && (
                        <button
                          onClick={() => enableWebhook(r.id)}
                          disabled={busy === `webhook:${r.id}`}
                          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                          title={polish ? "Włącz webhook" : "Enable webhook"}
                        >
                          {busy === `webhook:${r.id}` ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <Webhook size={15} />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {revealed?.rid === r.id ? (
                    <div className="mt-2 rounded-lg border border-hairline/40 bg-inset p-2.5 text-[12px]">
                      <div className="mb-1.5 text-ink-secondary">
                        {polish
                          ? "Webhook włączony — sekret pokazany tylko raz, skopiuj go teraz:"
                          : "Webhook enabled — the secret is shown only once, copy it now:"}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <code className="min-w-0 flex-1 truncate rounded bg-panel px-2 py-1 text-ink">{revealed.url}</code>
                        <button
                          onClick={() => copy(`url:${r.id}`, revealed.url)}
                          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                          title={polish ? "Kopiuj adres" : "Copy URL"}
                        >
                          {copied === `url:${r.id}` ? <Check size={13} className="text-success" /> : <ClipboardCopy size={13} />}
                        </button>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <code className="min-w-0 flex-1 truncate rounded bg-panel px-2 py-1 text-ink">{revealed.secret}</code>
                        <button
                          onClick={() => copy(`secret:${r.id}`, revealed.secret)}
                          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                          title={polish ? "Kopiuj sekret" : "Copy secret"}
                        >
                          {copied === `secret:${r.id}` ? <Check size={13} className="text-success" /> : <ClipboardCopy size={13} />}
                        </button>
                      </div>
                      <button
                        onClick={() => setRevealed(null)}
                        className="mt-2 rounded-md bg-raised px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
                      >
                        {polish ? "OK, ukryj sekret" : "OK, hide secret"}
                      </button>
                    </div>
                  ) : r.trigger ? (
                    <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset p-2 text-[12px]">
                      <code className="min-w-0 flex-1 truncate text-ink" title={r.trigger.url}>{r.trigger.url}</code>
                      <button
                        onClick={() => copy(`url:${r.id}`, r.trigger!.url)}
                        className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                        title={polish ? "Kopiuj adres webhooka" : "Copy webhook URL"}
                      >
                        {copied === `url:${r.id}` ? <Check size={13} className="text-success" /> : <ClipboardCopy size={13} />}
                      </button>
                    </div>
                  ) : null}

                  {ranId === r.id && (
                    <div className="mt-2 text-[12px] text-success">{polish ? "W kolejce — uruchomi się w ciągu minuty" : "Queued — runs within a minute"}</div>
                  )}

                </div>
              );
            })}
          </>
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
