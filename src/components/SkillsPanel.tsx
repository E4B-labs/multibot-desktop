// multibot: F8 — skille bota w prawym slocie (400px, jak Routines).
// Provider-neutral skills. Harness stores them per bot and injects enabled
// instructions into every provider turn.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  GraduationCap,
  Loader2,
  Pencil,
  Square,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { cn } from "@/lib/cn";
import { SkillRef } from "./SkillRef";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { parseSkillFile, type ParsedSkillFile } from "@/lib/skillFile";

// Lokalny helper jak w RoutinesPanel, plus `status` na błędzie: teach/start
// odróżnia "brak otwartej karty" (404) od realnej awarii po kodzie, nie po treści.
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    throw Object.assign(new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`), {
      status: res.status,
    });
  }
  return body;
}

/** Kształt wiersza z GET /api/bots/{id}/skills. */
interface Skill {
  name: string;
  command?: string;
  description: string;
  instructions: string;
  path?: string;
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

function SkillForm({
  skill,
  skillsRoot,
  onSaved,
  onCancel,
}: {
  skill: Skill;
  skillsRoot: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const polish = useLanguage() === "pl";
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState(skill.instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    api(`${skillsRoot}/${encodeURIComponent(skill.name)}`, {
      method: "PATCH",
      body: JSON.stringify({ description, instructions }),
    })
      .then(onSaved)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Edytuj" : "Edit"} {skill.name}</div>
      <label className="block">
        <div className="mb-1.5 text-[13px] text-ink-secondary">{polish ? "Opis" : "Description"}</div>
        <input
          className={inputCls}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={polish ? "Kiedy bot ma użyć tej umiejętności?" : "When should the bot reach for this skill?"}
        />
      </label>
      <label className="block">
        <div className="mb-1.5 text-[13px] text-ink-secondary">{polish ? "Instrukcje" : "Instructions"}</div>
        <textarea
          className={cn(inputCls, "min-h-[180px] resize-none font-mono text-[12px]")}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {error && <div className="text-[12px] text-danger">{error}</div>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {polish ? "Zapisz" : "Save"}
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

// Stany nagrywania: idle → recording → stopped (kroki czekają, usuwalne) →
// synthesizing → done. `noBrowser` to podpowiedź po 404 z teach/start — komputer
// jest gotowy, ale jego przeglądarka nie ma jeszcze otwartej karty.
type TeachState =
  | { phase: "idle"; noBrowser?: boolean }
  | { phase: "starting" }
  | { phase: "recording"; recordingId: string }
  | { phase: "stopping"; recordingId: string }
  | { phase: "stopped"; recordingId: string; steps: string[] }
  | { phase: "synthesizing" }
  | { phase: "done"; skillName: string };

// H6: mieszka tu (blisko reszty zarządzania skillami), ale renderuje ją panel
// Computer — nagrywanie dzieje się na ekranie bota, nie na liście skilli.
// Dlatego bierze gotowość komputera i przejęcie/oddanie leasa (H5) jako propsy
// zamiast duplikować tamtą logikę.
export function TeachCard({
  botId,
  onSkillCreated,
  polish,
  computerReady,
  notReadyLabel,
  onStartControl,
  onStopControl,
}: {
  /** Bot harnessu — nagrywa i syntezuje harness, jeden i ten sam identyfikator. */
  botId: string;
  onSkillCreated: () => void;
  polish: boolean;
  computerReady: boolean;
  notReadyLabel: string;
  /** H5 lease z ComputerPanel — przejęte automatycznie przy starcie, oddane po stopie. */
  onStartControl: () => void;
  onStopControl: () => void;
}) {
  const [teach, setTeach] = useState<TeachState>({ phase: "idle" });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setTeach({ phase: "starting" });
    setError(null);
    onStartControl(); // H6.3 — użytkownik zaraz zacznie klikać, potrzebuje sterowania
    api(`/api/bots/${botId}/teach/start`, { method: "POST" })
      .then(({ recording_id }: { recording_id: string }) =>
        setTeach({ phase: "recording", recordingId: recording_id }),
      )
      .catch((e: unknown) => {
        // Oddaj lease, którego `onStartControl` wziął w nadziei na nagranie —
        // bez tego nieudany start zostawiał użytkownika ze sterowaniem, a
        // agenta w kolejce, przy karcie z powrotem na „Rozpocznij nagrywanie".
        onStopControl();
        if ((e as { status?: number }).status === 404) {
          setTeach({ phase: "idle", noBrowser: true });
        } else {
          setTeach({ phase: "idle" });
          setError(e instanceof Error ? e.message : String(e));
        }
      });
  };

  const stop = (recordingId: string) => {
    setTeach({ phase: "stopping", recordingId });
    setError(null);
    onStopControl(); // demonstracja skończona — oddaj sterowanie z powrotem
    api(`/api/bots/${botId}/teach/stop`, {
      method: "POST",
      body: JSON.stringify({ recording_id: recordingId }),
    })
      .then(({ steps }: { steps: string[] }) => setTeach({ phase: "stopped", recordingId, steps }))
      .catch((e: unknown) => {
        setTeach({ phase: "idle" });
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const removeStep = (index: number) =>
    setTeach((t) => (t.phase === "stopped" ? { ...t, steps: t.steps.filter((_, i) => i !== index) } : t));

  // Nagrywa harness (CDP), skilla pisze bot swoim providerem. `steps` jedzie
  // z UI, bo użytkownik mógł usunąć krok przed syntezą; `recording_id` tylko
  // dla śladu w logach — trasa syntezy nagrania już nie czyta.
  const synthesize = (recordingId: string, steps: string[]) => {
    setTeach({ phase: "synthesizing" });
    setError(null);
    api(`/api/bots/${botId}/teach/synthesize`, {
      method: "POST",
      body: JSON.stringify({
        recording_id: recordingId,
        steps,
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    })
      .then(({ skill_name }: { skill_name: string }) => {
        setTeach({ phase: "done", skillName: skill_name });
        setName("");
        onSkillCreated();
      })
      .catch((e: unknown) => {
        setTeach({ phase: "idle" });
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  // K5: ikona przy „Przejmij sterowanie" i krzyżyk na pasku nagrywania startują
  // i przerywają nagranie, mimo że stan trzymamy tu. Faza leci w drugą stronę
  // jako zdarzenie, żeby czerwona ramka i pasek mogły się narysować na ekranie
  // bota, a nie tylko w tej karcie.
  const teachRef = useRef(teach);
  teachRef.current = teach;
  const startRef = useRef(start);
  startRef.current = start;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  // Puste zależności, bo `start` i `stop` powstają na nowo w każdym renderze —
  // z nimi na liście efekt przepinał nasłuch po każdym przerysowaniu karty.
  useEffect(() => {
    const onStart = () => {
      if (teachRef.current.phase === "idle") startRef.current();
    };
    const onStop = () => {
      const t = teachRef.current;
      if (t.phase === "recording" || t.phase === "stopping") stopRef.current(t.recordingId);
    };
    window.addEventListener("mb:teach:start", onStart);
    window.addEventListener("mb:teach:stop", onStop);
    return () => {
      window.removeEventListener("mb:teach:start", onStart);
      window.removeEventListener("mb:teach:stop", onStop);
    };
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("mb:teach:phase", { detail: teach }));
  }, [teach]);

  return (
    <div className="mt-3 rounded-xl bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
        <GraduationCap size={16} className="text-ink-secondary" />
        {polish ? "Nagraj umiejętność" : "Record a skill"}
      </div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {polish
          ? "Pokaż botowi zadanie na jego komputerze — obejrzy Twoje kliknięcia i sam napisze sobie umiejętność."
          : "Show the bot a task on its computer — it watches your clicks and writes itself a skill."}
      </div>

      {teach.phase === "idle" &&
        (!computerReady ? (
          <div className="mt-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12px] text-ink-secondary">
            {notReadyLabel}
          </div>
        ) : (
          <>
            {teach.noBrowser && (
              <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
                {polish
                  ? "Przeglądarka na komputerze bota nie ma jeszcze otwartej karty — otwórz stronę i spróbuj ponownie."
                  : "The browser on the bot's computer has no open tab yet — open a page there, then start again."}
              </div>
            )}
            <button
              onClick={start}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              <Circle size={13} className="text-danger" />
              {polish ? "Rozpocznij nagrywanie" : "Start recording"}
            </button>
          </>
        ))}

      {teach.phase === "starting" && (
        <div className="mt-3 flex items-center justify-center gap-2 py-1 text-[13px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" />
          {polish ? "Łączenie z komputerem…" : "Connecting to the computer…"}
        </div>
      )}

      {(teach.phase === "recording" || teach.phase === "stopping") && (
        <>
          <div className="mt-3 flex items-center gap-2 text-[13px] text-ink">
            <span className="size-2 animate-pulse rounded-full bg-danger" />
            {polish
              ? "Nagrywanie — pokaż zadanie na komputerze bota"
              : "Recording — demonstrate the task on the bot's computer"}
          </div>
          <button
            onClick={() => stop(teach.recordingId)}
            disabled={teach.phase === "stopping"}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {teach.phase === "stopping" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Square size={12} className="fill-current" />
            )}
            {polish ? "Zatrzymaj nagrywanie" : "Stop recording"}
          </button>
        </>
      )}

      {teach.phase === "stopped" && (
        <>
          <div className="mb-1.5 mt-3 text-[13px] text-ink-secondary">
            {polish ? "Co zobaczył bot" : "What the bot saw"}
          </div>
          {teach.steps.length === 0 ? (
            <div className="rounded-lg bg-inset p-3 text-[12px] text-ink-secondary">
              {polish ? "Brak zarejestrowanych kroków" : "No steps recorded"}
            </div>
          ) : (
            <ul className="max-h-[160px] overflow-y-auto rounded-lg bg-inset p-1">
              {teach.steps.map((step, i) => (
                <li
                  key={i}
                  className="flex items-start justify-between gap-2 rounded-md px-2 py-1.5 text-[12px] leading-relaxed text-ink hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 break-words">{step}</span>
                  <button
                    onClick={() => removeStep(i)}
                    className="shrink-0 rounded p-0.5 text-ink-secondary hover:text-danger"
                    title={polish ? "Usuń krok" : "Delete step"}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            className={cn(inputCls, "mt-2")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              polish ? "Nazwa umiejętności (opcjonalnie — bot sam wybierze)" : "Skill name (optional — the bot picks one)"
            }
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => synthesize(teach.recordingId, teach.steps)}
              disabled={teach.steps.length === 0}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Wand2 size={13} />
              {polish ? "Utwórz umiejętność" : "Create skill"}
            </button>
            <button
              onClick={() => setTeach({ phase: "idle" })}
              className="rounded-lg bg-raised px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              {polish ? "Odrzuć" : "Discard"}
            </button>
          </div>
        </>
      )}

      {teach.phase === "synthesizing" && (
        <div className="mt-3 flex items-center justify-center gap-2 py-1 text-[13px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" />
          {polish
            ? "Bot pisze umiejętność — to może potrwać kilka minut…"
            : "The bot is writing the skill — this can take a few minutes…"}
        </div>
      )}

      {teach.phase === "done" && (
        <>
          <div className="mt-3 text-[13px] text-success">
            {polish ? "Utworzono umiejętność: " : "Skill created: "}
            <SkillRef name={teach.skillName} />
          </div>
          <button
            onClick={() => setTeach({ phase: "idle" })}
            className="mt-2 w-full rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover"
          >
            {polish ? "Nagraj kolejny" : "Record another"}
          </button>
        </>
      )}

      {error && (
        <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

export function SkillsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const skillsRoot = `/api/bots/${bot.id}/skills`;
  const [status, setStatus] = useState<"loading" | "offline" | "ready">("loading");
  const [skills, setSkills] = useState<Skill[]>([]);
  // multibot: panel otwarty klikiem w nazwę skilla w czacie startuje rozwinięty
  // na tym skillu — inaczej trzeba go było szukać na liście.
  const [expanded, setExpanded] = useState<string | null>(state.skillFocus);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "delete:<name>"
  const [error, setError] = useState<string | null>(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillInstructions, setNewSkillInstructions] = useState("");
  const [creating, setCreating] = useState(false);
  // multibot: .md z pulpitu upuszczony na panel = nowa umiejętność.
  // W Electronie `dataTransfer.files` działa w rendererze bez IPC. Android
  // WebView nie zna upuszczania plików — kod jest tam martwy, nie szkodliwy.
  const [dragOver, setDragOver] = useState(false);
  const [dropping, setDropping] = useState(false);
  const dragCounter = useRef(0);
  // ref, nie `dropping` — stan nie zdąży się odświeżyć między dwoma szybkimi
  // zrzutami tego samego pliku, a drugi dostałby 409
  const inFlight = useRef(false);

  const load = () =>
    api(skillsRoot).then((ss: Skill[]) => {
      setSkills(ss);
      setStatus("ready");
      // multibot: nazwy skilli do podświetlania w treści wiadomości (skillRefs)
      dispatch({ type: "setSkills", skills: ss.map((s) => ({ name: s.name, description: s.description })) });
    });

  useEffect(() => {
    if (state.skillFocus) setExpanded(state.skillFocus);
  }, [state.skillFocus]);

  useEffect(() => {
    let alive = true;
    load()
      .catch(() => alive && setStatus("offline"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [skillsRoot]);

  const showError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  // Bez dialogu potwierdzenia — wzorzec repo (delete rutyny/bota też jest
  // bezpośredni), destruktywność sygnalizuje styl danger.
  const remove = (name: string) => {
    setBusy(`delete:${name}`);
    setError(null);
    api(`${skillsRoot}/${encodeURIComponent(name)}`, { method: "DELETE" })
      .then(() => setSkills((ss) => ss.filter((s) => s.name !== name)))
      .catch(showError)
      .finally(() => setBusy(null));
  };

  // Najpierw rozbiera się WSZYSTKIE pliki, dopiero potem leci pierwszy POST.
  // Nie dla elegancji: udany POST rozgłasza `workspace`, App podbija
  // `workspaceVersion`, a ten panel wisi na `key` z tej wartości — czyli
  // przemontowuje się i gubi swój stan. Komunikat o błędzie ustawiony PO
  // pierwszym udanym zapisie nigdy by się nie pokazał.
  // ponytail: błąd z samego serwera (np. 409 na drugim z trzech plików) wciąż
  // może zginąć w tym przemontowaniu — `workspaceVersion` jest licznikiem
  // GLOBALNYM, więc podbija go też bot zapisujący pamięć w tle. Gdy zacznie
  // boleć, błąd musi wyjść z panelu do store'a (albo `key` przestać zależeć
  // od tej wartości).
  const dropFiles = useCallback(async (files: File[]) => {
    if (inFlight.current) return;
    const bad = files.filter((file) => !/\.(md|markdown)$/i.test(file.name));
    if (bad.length || !files.length) {
      // Cały zrzut idzie do kosza, nie tylko złe pliki — komunikat musi to
      // powiedzieć wprost, inaczej przy „a.md b.md logo.png" użytkownik jest
      // przekonany, że dwa skille jednak weszły.
      const names = bad.map((file) => file.name).join(", ");
      setError(
        polish
          ? `Same pliki .md, proszę — nic nie dodano${names ? ` (odrzucone: ${names})` : ""}`
          : `Only .md skill files — nothing added${names ? ` (rejected: ${names})` : ""}`,
      );
      return;
    }
    // serwer tnie instrukcje na 100 000 znaków BŁĘDEM, nie przycięciem —
    // lepiej powiedzieć to przed wysłaniem całego pliku
    const big = files.find((file) => file.size > 100_000);
    if (big) {
      setError(
        polish
          ? `${big.name} jest za duży na umiejętność (limit 100 000 znaków)`
          : `${big.name} is too large for a skill (100,000 character limit)`,
      );
      return;
    }
    inFlight.current = true;
    setDropping(true);
    setError(null);
    try {
      const parsed: ParsedSkillFile[] = [];
      for (const file of files) {
        try {
          parsed.push(parseSkillFile(file.name, await file.text()));
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      for (const skill of parsed) {
        const created: Skill = await api(skillsRoot, { method: "POST", body: JSON.stringify(skill) });
        setSkills((items) => [...items, created]);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setDropping(false);
    }
  }, [polish, skillsRoot]);

  const create = () => {
    if (creating || !newSkillName.trim() || !newSkillInstructions.trim()) return;
    setCreating(true);
    api(skillsRoot, { method: "POST", body: JSON.stringify({ name: newSkillName, instructions: newSkillInstructions }) })
      .then((skill: Skill) => { setSkills((items) => [...items, skill]); setNewSkillName(""); setNewSkillInstructions(""); })
      .catch(showError)
      .finally(() => setCreating(false));
  };

  return (
    <aside
      className={cn(
        "animate-panel-in relative flex h-full w-[360px] shrink-0 flex-col border-l border-hairline/40 bg-panel",
        dragOver && "outline outline-2 outline-dashed outline-offset-[-6px] outline-accent/70",
      )}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragCounter.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = 0;
        setDragOver(false);
        void dropFiles([...e.dataTransfer.files]);
      }}
    >
      {/* Header */}
      <div data-shell-header className="flex items-center justify-between px-4 py-3">
        <span className="w-[26px]" />
        <span className="text-[15px] font-semibold text-ink">{polish ? "Umiejętności" : "Skills"}</span>
        <button
          onClick={() => dispatch({ type: "toggleSkills", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {status === "offline" ? (
          // Konwencja local runtime controls
          <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className="size-1.5 rounded-full bg-raised-hover" />
              {polish ? "Usługa offline" : "Service offline"}
          </div>
        ) : status === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> {polish ? "Ładowanie umiejętności…" : "Loading skills…"}
          </div>
        ) : editing ? (
          <SkillForm
            skill={editing}
            skillsRoot={skillsRoot}
            onSaved={() => {
              setEditing(null);
              load().catch(() => setStatus("offline"));
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            <div className="mt-3 rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">{polish ? "Nowa umiejętność" : "New skill"}</div>
              <input className={cn(inputCls, "mt-3")} value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} placeholder={polish ? "Nazwa umiejętności" : "Skill name"} />
              <textarea className={cn(inputCls, "mt-2 min-h-[100px] resize-y")} value={newSkillInstructions} onChange={(e) => setNewSkillInstructions(e.target.value)} placeholder={polish ? "Instrukcje dla bota" : "Instructions the bot should follow"} />
              <button onClick={create} disabled={creating || !newSkillName.trim() || !newSkillInstructions.trim()} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink disabled:opacity-40"><Check size={13} /> {polish ? "Utwórz umiejętność" : "Create skill"}</button>
            </div>

            {skills.length === 0 ? (
              <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
                <Wand2 size={22} />
                <div className="text-[13px] font-medium text-ink">{polish ? "Brak umiejętności" : "No skills yet"}</div>
                <span className="text-[12px]">
                  {polish ? "Umiejętności to procedury współdzielone przez boty. Utwórz je powyżej albo poproś bota, by napisał własną." : "Skills are reusable playbooks shared by every bot — teach one above, or ask a bot to write one for itself."}
                </span>
              </div>
            ) : (
              skills.map((s) => {
                const open = expanded === s.name;
                return (
                  <div key={s.name} className="mt-3 rounded-xl bg-card p-4">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => setExpanded(open ? null : s.name)}
                        className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
                        title={s.path ?? s.name}
                      >
                        {open ? (
                          <ChevronDown size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
                        ) : (
                          <ChevronRight size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
                        )}
                         <span className="min-w-0">
                           <span className="block truncate text-[15px] font-medium text-ink">
                             <span className="mr-1 text-ink-secondary">⌘</span>{s.command ?? `/${s.name}`}
                           </span>
                          <span className="mt-0.5 block text-[13px] text-ink-secondary">
                            {s.description || (polish ? "Brak opisu" : "No description")}
                          </span>
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => setEditing(s)}
                          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                          title={polish ? "Edytuj" : "Edit"}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => remove(s.name)}
                          disabled={busy === `delete:${s.name}`}
                          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50"
                          title={polish ? "Usuń" : "Delete"}
                        >
                          {busy === `delete:${s.name}` ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <Trash2 size={15} />
                          )}
                        </button>
                      </div>
                    </div>
                    {open && (
                      <div className="mt-3 border-t border-hairline/40 pt-3 text-[13px]">
                        <div className="mb-2 truncate text-[11px] text-ink-secondary" title={s.path ?? s.name}>
                          {s.path ?? (polish ? "Wspólna umiejętność bota" : "Shared bot skill")}
                        </div>
                        {s.instructions ? (
                          <ChatMarkdown text={s.instructions} />
                        ) : (
                          <div className="text-ink-secondary">{polish ? "Brak instrukcji" : "No instructions"}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </>
        )}

        {dropping && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" />
            {polish ? "Wczytuję umiejętność…" : "Adding skill…"}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-panel/80 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-accent/60 bg-card px-8 py-6 text-center shadow-2xl">
            <span className="flex size-11 items-center justify-center rounded-full bg-accent/15 text-accent">
              <Upload size={22} />
            </span>
            <span className="text-[14px] font-semibold text-ink">
              {polish ? "Upuść tu plik .md" : "Drop .md skill here"}
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}
