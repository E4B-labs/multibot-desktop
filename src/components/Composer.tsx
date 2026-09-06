import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Brain, CalendarClock, File as FileIcon, Loader2, Mic, Plus, Puzzle, Shield, SlidersHorizontal, Wand2, Wrench, X, Zap } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { MausAvatar } from "./Avatar";
import { normalizeState, stripMascotState } from "@/lib/mascot";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import { parseSchedule, type PresetOrUnknown } from "@/lib/routineSchedule";
import { AttachmentCard } from "./AttachmentCard";
import { randomId } from "@/lib/shell";

// multibot: szybki przełącznik dostępu w composerze (port z OpenMausBot #442,
// tam PermissionModeSelector) — te same endpointy co EngineAutonomy.
type ComposerAccess = "read-only" | "approval" | "full";

const ACCESS_LABELS: Record<ComposerAccess, { pl: string; en: string }> = {
  "read-only": { pl: "Tylko odczyt", en: "Read Only" },
  approval: { pl: "Pytaj o zgodę", en: "Ask for approval" },
  full: { pl: "Pełny dostęp", en: "Full Access" },
};

function normalizeAccess(value: unknown): ComposerAccess {
  return value === "read-only" || value === "full" ? value : "approval";
}

function ComposerAccessPill({ bot, collapsed }: { bot: Bot; collapsed: boolean }) {
  const polish = useLanguage() === "pl";
  const [access, setAccess] = useState<ComposerAccess>("approval");
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    api(`/api/bots/${bot.id}/access`)
      .then((value: { access?: string }) => {
        if (!active) return;
        setAccess(normalizeAccess(value.access));
        setReady(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [bot.id]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (next: ComposerAccess) => {
    setOpen(false);
    if (next === access) return;
    const previous = access;
    setAccess(next);
    api(`/api/bots/${bot.id}/access`, { method: "PATCH", body: JSON.stringify({ access: next }) })
      .then((value: { access?: string }) => setAccess(normalizeAccess(value.access)))
      .catch(() => setAccess(previous));
  };

  if (!ready) return null;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex items-center rounded-full text-[11px] font-medium",
          composerPillShape(collapsed),
          open ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
        title={`${polish ? "Dostęp" : "Access"}: ${polish ? ACCESS_LABELS[access].pl : ACCESS_LABELS[access].en}`}
        aria-label={`${polish ? "Dostęp" : "Access"}: ${polish ? ACCESS_LABELS[access].pl : ACCESS_LABELS[access].en}`}
      >
        <Shield size={14} />
        {/* multibot: podpis chowa `collapsed`, nie osobna bramka `lg:`. Przy
            dwóch warunkach naraz poniżej 1024 px wychodziła pigułka bez
            podpisu, ale wciąż z `px-2` — 30 px obok 32-pikselowych kwadratów
            sąsiadów. Jeden warunek = jeden kształt. */}
        {!collapsed && <span>{polish ? ACCESS_LABELS[access].pl : ACCESS_LABELS[access].en}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full right-0 z-30 mb-2 min-w-44 overflow-hidden rounded-xl border border-hairline/40 bg-card p-1 shadow-xl">
          {(Object.keys(ACCESS_LABELS) as ComposerAccess[]).map((item) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={access === item}
              onClick={() => choose(item)}
              className={cn(
                "flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[12px] text-ink",
                access === item ? "bg-raised" : "hover:bg-raised/60",
              )}
            >
              {polish ? ACCESS_LABELS[item].pl : ACCESS_LABELS[item].en}
              {access === item && <span className="text-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

// multibot: F8 — /slash autocomplete. Skill wysyła się jako ZWYKŁA wiadomość:
// gateway silnika sam rozwiązuje `/nazwa reszta` na treść skilla
// (engine/server/gateway.py → skills.slash_message), więc picker tylko wstawia
// tekst. Zapytanie jest aktywne, dopóki cała treść to jeden token "/..." —
// spacja kończy komendę i zamyka picker (rozłączne z @mention: tam pierwszym
// znakiem tokenu jest "@" po spacji, tu "/" na początku wiadomości).
function slashQuery(text: string): string | null {
  if (!/^\/\S*$/.test(text)) return null;
  return text.slice(1).toLowerCase();
}

/**
 * Treść composera po wybraniu komendy w palecie poleceń. Gateway rozwiązuje
 * `/nazwa reszta`, więc dotychczasowy tekst staje się argumentami skilla zamiast
 * zniknąć. Wyjątek: gdy treść JEST już komendą, podmieniamy ją — inaczej wyszłoby
 * `/model /szukaj`, czyli dwie komendy naraz i żadna z nich poprawna.
 */
export function withCommand(text: string, command: string): string {
  const rest = text.trim();
  return !rest || rest.startsWith("/") ? `${command} ` : `${command} ${rest}`;
}

/** Wiersze pickera: kształt z GET /api/bots/{id}/skills. */
interface SlashSkill {
  name: string;
  command: string;
  description: string;
}

/** multibot: wiersz pickera @mention — boty (tag przez ask_bot) i skille
 *  (wstawienie `/komendy` do wiadomości, jak z palety "/"). */
type MentionRow = { type: "bot"; peer: Bot } | { type: "skill"; skill: SlashSkill };

// multibot: paleta "/" nie kończy się na skillach — pokazuje też akcje
// harnessu, wtyczki, agentów i rutyny. Wzór wiersza z Grok Bota: nazwa, podpis
// kontekstowy i etykieta typu przy prawej krawędzi. Skille i `/model` nadal
// TYLKO wstawiają tekst (brak `run`), reszta odpala dispatch. Rutyna wyłącznie
// OTWIERA panel — uruchomienie ma skutki uboczne i nie może wyjść z pickera.
export type SlashKind = "action" | "skill" | "plugin" | "agent" | "routine";

export interface SlashRow {
  id: string;
  /** Tekst wiersza; dla skilli to zarazem komenda do wstawienia ("/model"). */
  label: string;
  hint: string;
  kind: SlashKind;
  icon?: ReactNode;
  run?: () => void;
}

const SLASH_KINDS: SlashKind[] = ["action", "skill", "plugin", "agent", "routine"];
const SLASH_TYPE: Record<SlashKind, [string, string]> = {
  action: ["Action", "Akcja"],
  skill: ["Skill", "Umiejętność"],
  plugin: ["Plugin", "Wtyczka"],
  agent: ["Agent", "Agent"],
  routine: ["Routine", "Rutyna"],
};
const SLASH_ICON: Record<SlashKind, ReactNode> = {
  action: <SlidersHorizontal size={15} />,
  skill: <Wand2 size={15} />,
  plugin: <Puzzle size={15} />,
  agent: <Wrench size={15} />,
  routine: <CalendarClock size={15} />,
};
// Podpis rutyny to zdanie z presetu, nigdy surowy cron — tak samo jak karty w
// RoutinesPanel.
const SLASH_SCHEDULE: Record<PresetOrUnknown, [string, string]> = {
  manual: ["Manual", "Ręczna"],
  hourly: ["Every hour", "Co godzinę"],
  daily: ["Daily", "Codziennie"],
  weekly: ["Weekly", "Co tydzień"],
  monthly: ["Monthly", "Co miesiąc"],
  unknown: ["Scheduled", "Zaplanowana"],
};

/** Filtr palety plus limit na kategorię: bez limitu same akcje i skille zjadają
 * całą listę i wtyczki, agenci ani rutyny nigdy się nie pokazują. Kolejność
 * kategorii stała, w obrębie kategorii zachowana z wejścia. */
export function slashVisible(rows: SlashRow[], query: string): SlashRow[] {
  const q = query.trim().toLowerCase();
  const hit = rows.filter((row) => !q || row.label.replace(/^\//, "").toLowerCase().includes(q));
  return SLASH_KINDS.flatMap((kind) => hit.filter((row) => row.kind === kind).slice(0, 5));
}

interface PendingAttachment {
  id: string;
  file: File;
  preview?: string;
  status: "ready" | "uploading" | "error";
}

type ReasoningLevel = "default" | "low" | "medium" | "high" | "xhigh" | "max";
const REASONING_LEVELS: Array<{ id: ReasoningLevel; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X high" },
  { id: "max", label: "Max" },
];

// Mirrors supportsMaxReasoning in server/drivers/codex.ts — front and server
// live in separate tsconfig projects, so the one line stays duplicated.
const supportsMaxReasoning = (model: string) => model === "gpt-6-astra" || model.startsWith("gpt-5.6-");

/** multibot: „Fast mode" = service tier `priority` codeksa („Fast", 1.5x speed,
 * increased usage). Ma go tylko driver `codex`, i tam każdy model poza
 * `gpt-5.4-mini` (pusta lista `serviceTiers` w `model/list`). Mirror
 * supportsFastMode z server/drivers/codex.ts — front i serwer to osobne
 * projekty tsconfig, więc ta jedna linia zostaje zduplikowana. */
export function fastModeAvailable(driverKind: string | undefined, model: string): boolean {
  return driverKind === "codex" && model !== "gpt-5.4-mini";
}

/** multibot: czy z prawej stoi otwarty panel boczny, czyli czy kolumna czatu
 * jest zwężona. Wtedy pigułki composera (rozumowanie, tryb szybki, dostęp)
 * zwijają się do samej ikony — podpis mówi `title` i `aria-label`.
 *
 * Liczą się WYŁĄCZNIE panele będące `<aside>` obok czatu (App.tsx): ustawienia
 * bota, inspektor, komputer, rutyny, skille. `pluginsOpen` i `teamMapOpen` to
 * nakładki na całą powłokę (`absolute inset-0`), a grupa, pokój, poczta
 * i ustawienia aplikacji renderują się ZAMIAST ChatView — pod żadnym z nich
 * composera nie widać, więc nie mają czego zwijać. */
export function sidePanelOpen(panels: {
  settingsOpen: boolean;
  inspectorOpen: boolean;
  computerOpen: boolean;
  routinesOpen: boolean;
  skillsOpen: boolean;
}): boolean {
  return (
    panels.settingsOpen ||
    panels.inspectorOpen ||
    panels.computerOpen ||
    panels.routinesOpen ||
    panels.skillsOpen
  );
}

/** Pigułka composera: pełna (ikona + podpis) albo zwinięta do kwadratu 32 px.
 * Ten sam obrys co przyciski mikrofonu i załącznika, więc zwinięty rząd jest
 * równy, a odstępy między ikonami nie rozjeżdżają się o wewnętrzny padding. */
export function composerPillShape(collapsed: boolean): string {
  return collapsed ? "size-8 justify-center px-0" : "h-8 gap-1 px-2";
}

export function reasoningLevels(model: string) {
  // Claude Code does not expose adaptive effort for Haiku; leave provider
  // default intact instead of sending an unsupported value.
  if (model.toLowerCase().includes("haiku")) return [{ id: "default" as const, label: "Default" }];
  return supportsMaxReasoning(model) ? REASONING_LEVELS : REASONING_LEVELS.filter((level) => level.id !== "max");
}

/** `onSend` przejmuje wysyłkę (czat grupowy: jedna wiadomość do całej grupy,
 * nie do `bot`). Bez niego composer wysyła do `bot` jak dotąd. `bot` zostaje w
 * obu trybach, bo to on karmi pasek maskotki i model picker. Zwrócone `false`
 * znaczy „nie przyjęte" — tekst ZOSTAJE w polu, bo cicho skasowana wiadomość
 * jest gorsza niż brak wysyłki. Załączników tu nie ma: grupa nie ma jednego
 * właściciela pliku, więc spinacz w tym trybie znika zamiast gubić plik. */
export function Composer({ bot, onSend }: { bot: Bot; onSend?: (text: string) => boolean }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningLevel>("low");
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  // multibot: pasek nad composerem — JEDYNY animowany bot w aplikacji. Stan
  // wybiera czysta `stripMascotState`; `null` znaczy „pasek pusty".
  const runtime = state.runtime[bot.threadId] ?? null;
  // Wiersze zależne od czasu (loading po 10 s, celebrate gaśnie po 1 s) nie mają
  // własnego eventu, więc przy żywej turze przeliczamy je co pół sekundy.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!bot.busy && !runtime) return;
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, [bot.busy, runtime]);
  const strip = stripMascotState({
    bot,
    runtime,
    streaming: state.streaming[bot.threadId] !== undefined,
    focused: typeof document === "undefined" || document.hasFocus(),
    now: clock,
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const previewUrls = useRef(new Set<string>());
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // multibot: Web Speech API dictation — works in any Chrome, including plain
  // vite on Windows. The Electron bridge keeps priority when present (packaged
  // macOS: webkitSpeechRecognition exists there but its recognition service
  // fails without a Google key); Web Speech covers every browser without the
  // bridge. Final results append after baseText; interim results show live in
  // the input. Recognition language follows navigator.language. Second mic
  // click / Esc stops.
  const WebSpeech: (new () => any) | undefined =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  // multibot: G5 — microphone APIs require secure context; localhost remains
  // the browser exception, plain LAN HTTP must explain limitation clearly.
  const secureContext = window.isSecureContext || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const webSpeechActive = !!WebSpeech && !window.ogb && secureContext;
  const webRec = useRef<any>(null);
  useEffect(() => {
    if (!recording || !webSpeechActive) return;
    setSpeechError(null);
    const rec: any = new WebSpeech();
    webRec.current = rec;
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const t = String(r[0]?.transcript ?? "").trim();
          if (t) baseText.current = baseText.current ? `${baseText.current} ${t}` : t;
        } else {
          interim += r[0]?.transcript ?? "";
        }
      }
      const shown = interim.trim()
        ? baseText.current
          ? `${baseText.current} ${interim.trim()}`
          : interim.trim()
        : baseText.current;
      setText(shown);
    };
    rec.onerror = (e: any) => {
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        setSpeechError("Dictation needs microphone access — allow it for this site.");
      } else if (e?.error && e.error !== "aborted" && e.error !== "no-speech") {
        setSpeechError(`Dictation failed: ${e.error}`);
      }
      setRecording(false);
    };
    rec.onend = () => setRecording(false);
    rec.start();
    return () => {
      webRec.current = null;
      rec.onresult = rec.onerror = rec.onend = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [recording, WebSpeech]);

  // ── @mention picker (boty do ztagowania + skille do wstawienia) ──
  const mention = mentionQueryAt(text, caret);

  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);

  // multibot: F8 — picker skilli po "/" i po "@": mechanika 1:1 z @mention
  // (strzałki, Enter/Tab wstawia, Esc chowa do następnej zmiany tekstu).
  // ŹRÓDŁO SKILLI: harness per bot (`/api/bots/{id}/skills`) — ten sam, z którego
  // czyta panel Umiejętności; harness trzyma je per bot i wstrzykuje w każdą turę.
  // multibot: rutyny są per bot, więc cache trzyma id bota — bez tego
  // przełączenie bota zostawiłoby w palecie cudzą listę.
  const [slashSkills, setSlashSkills] = useState<{ botId: string; rows: SlashSkill[] } | null>(
    null,
  );
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashHighlight, setSlashHighlight] = useState(0);
  // `/model` belongs to harness, so it works for every provider.
  const slashQ = slashQuery(text);
  // multibot: listę skilli doładujemy też dla @mention — picker "@" pokazuje
  // boty ORAZ skille.
  const skillsWanted = slashQ !== null || mention !== null;
  useEffect(() => {
    if (!skillsWanted || slashSkills?.botId === bot.id) return;
    let alive = true;
    authFetch(`/api/bots/${bot.id}/skills`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((ss: SlashSkill[]) =>
        alive && setSlashSkills({ botId: bot.id, rows: Array.isArray(ss) ? ss : [] }),
      )
      .catch(() => alive && setSlashSkills({ botId: bot.id, rows: [] }));
    return () => {
      alive = false;
    };
  }, [skillsWanted, slashSkills, bot.id]);

  // Kandydaci @mention stoją za deklaracją `slashSkills` — skille są częścią
  // tej samej listy. Boty zostają na górze, skille za nimi (max 4).
  const candidates = useMemo<MentionRow[]>(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const peers = state.bots.filter((b) => b.id !== bot.id && !b.hidden);
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && peers.some((b) => b.name.toLowerCase() === q)) return [];
    // multibot: boty zostają na górze listy, skille za nimi — filtr po nazwie
    // i komendzie, maksymalnie cztery, żeby dropdown się nie rozjeżdżał.
    const botRows: MentionRow[] = peers
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map((peer) => ({ type: "bot", peer }));
    const skillRows: MentionRow[] = (slashSkills?.botId === bot.id ? slashSkills.rows : [])
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.command.toLowerCase().includes(q),
      )
      .slice(0, 4)
      .map((skill) => ({ type: "skill", skill }));
    return [...botRows, ...skillRows];
  }, [mention, dismissedAt, state.bots, bot.id, slashSkills]);
  const pickerOpen = candidates.length > 0;
  // multibot: wtyczki z tego samego katalogu, z którego żyje panel wtyczek;
  // status połączenia to druga runda, dokładnie jak w PluginsPanel. W palecie
  // pokazujemy tylko realnie podpięte: własne serwery MCP i połączone karty
  // Composio — cały katalog to setki pozycji, których nikt tu nie szuka.
  const [slashPlugins, setSlashPlugins] = useState<
    Array<{ slug: string; label: string; logo: string | null; custom: boolean }> | null
  >(null);
  useEffect(() => {
    if (slashQ === null || slashPlugins !== null) return;
    let alive = true;
    const get = (path: string) =>
      authFetch(path).then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))));
    void (async () => {
      try {
        const catalog = await get("/api/connectors/catalog");
        const cards: Array<{ slug: string; label: string; logo: string | null; source?: string }> = catalog.cards ?? [];
        const slugs = cards.filter((c) => c.source !== "custom").map((c) => c.slug).slice(0, 40);
        const services: Record<string, { connected?: boolean }> =
          catalog.configured && slugs.length ? (await get(`/api/connectors?services=${slugs.join(",")}`)).services ?? {} : {};
        const rows = cards
          .filter((c) => c.source === "custom" || services[c.slug]?.connected)
          .map((c) => ({ slug: c.slug, label: c.label, logo: c.logo, custom: c.source === "custom" }));
        if (alive) setSlashPlugins(rows);
      } catch {
        if (alive) setSlashPlugins([]); // graceful absence: brak katalogu = brak wierszy
      }
    })();
    return () => {
      alive = false;
    };
  }, [slashQ, slashPlugins]);

  // multibot: rutyny są per bot, więc cache trzyma id bota — bez tego
  // przełączenie bota zostawiłoby w palecie cudzą listę.
  const [slashRoutines, setSlashRoutines] = useState<
    { botId: string; rows: Array<{ id: string; name: string; schedule: string | null }> } | null
  >(null);
  useEffect(() => {
    if (slashQ === null || slashRoutines?.botId === bot.id) return;
    let alive = true;
    authFetch(`/api/bots/${bot.id}/routines`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((rows) => alive && setSlashRoutines({ botId: bot.id, rows: Array.isArray(rows) ? rows : [] }))
      .catch(() => alive && setSlashRoutines({ botId: bot.id, rows: [] }));
    return () => {
      alive = false;
    };
  }, [slashQ, slashRoutines, bot.id]);

  const slashCandidates = useMemo(() => {
    if (slashQ === null || slashDismissed) return [];
    // multibot: akcje to wyłącznie dispatche, które store naprawdę zna
    // (te same, którymi steruje paleta Cmd+K); panele botowe otwierają się na
    // bocie z tego czatu, bo Shell renderuje je dla zaznaczonego bota.
    const here = polish ? "Ten czat" : "Current chat";
    const app = polish ? "Aplikacja" : "App";
    const rows: SlashRow[] = [
      { id: "model", label: "/model", hint: polish ? "Zmień dostawcę i model" : "Switch provider and model", kind: "action" },
      { id: "goal", label: "/goal", hint: polish ? "Cel: bot goni go przez wiele tur" : "Goal: the bot pursues it across turns", kind: "action" },
      { id: "a-settings", label: polish ? "Ustawienia bota" : "Bot settings", hint: here, kind: "action", run: () => dispatch({ type: "toggleSettings", open: true }) },
      { id: "a-computer", label: polish ? "Komputer bota" : "Bot's computer", hint: here, kind: "action", run: () => dispatch({ type: "toggleComputer", open: true }) },
      { id: "a-skills", label: polish ? "Umiejętności" : "Skills", hint: here, kind: "action", run: () => dispatch({ type: "toggleSkills", open: true }) },
      { id: "a-routines", label: polish ? "Rutyny" : "Routines", hint: here, kind: "action", run: () => dispatch({ type: "toggleRoutines", open: true }) },
      { id: "a-plugins", label: polish ? "Wtyczki" : "Plugins", hint: app, kind: "action", run: () => dispatch({ type: "togglePlugins", open: true }) },
      { id: "a-app", label: polish ? "Ustawienia aplikacji" : "App settings", hint: app, kind: "action", run: () => dispatch({ type: "toggleAppSettings", open: true }) },
      { id: "a-new-bot", label: polish ? "Nowy bot" : "New bot", hint: polish ? "Panel boczny" : "Sidebar", kind: "action", run: () => dispatch({ type: "newBot" }) },
      ...(slashSkills?.botId === bot.id ? slashSkills.rows : []).map((skill) => ({
        id: `s-${skill.name}`,
        label: skill.command ?? `/${skill.name}`,
        hint: skill.description,
        kind: "skill" as const,
      })),
      ...(slashPlugins ?? []).map((plugin) => ({
        id: `p-${plugin.slug}`,
        label: plugin.label,
        hint: plugin.custom ? "MCP" : polish ? "połączone" : "connected",
        kind: "plugin" as const,
        icon: plugin.logo ? <img src={plugin.logo} alt="" className="size-4 rounded" /> : undefined,
        run: () => dispatch({ type: "togglePlugins", open: true }),
      })),
      ...state.bots.filter((peer) => !peer.hidden).map((peer) => ({
        id: `b-${peer.id}`,
        label: botDisplayName(peer, polish ? "pl" : "en"),
        hint: peer.id === bot.id ? (polish ? "Bieżący" : "Current") : (polish ? "Przełącz" : "Switch to bot"),
        kind: "agent" as const,
        icon: <MausAvatar color={peer.color} avatarUrl={peer.avatarUrl} shape={peer.mascotShape} state={normalizeState(peer.mascotExpression) ?? "happy"} size={20} animated={false} />,
        run: () => dispatch({ type: "select", id: peer.id }),
      })),
      ...(slashRoutines?.rows ?? []).map((routine) => ({
        id: `r-${routine.id}`,
        label: routine.name,
        hint: SLASH_SCHEDULE[parseSchedule(routine.schedule).preset][polish ? 1 : 0],
        kind: "routine" as const,
        run: () => dispatch({ type: "toggleRoutines", open: true }),
      })),
    ];
    return slashVisible(rows, slashQ);
  }, [slashQ, slashDismissed, slashSkills, slashPlugins, slashRoutines, state.bots, bot.id, dispatch, polish]);
  const slashOpen = slashCandidates.length > 0;
  // multibot: lista dojeżdża asynchronicznie (wtyczki, rutyny), więc reset
  // podświetlenia idzie też po zmianie jej długości
  useEffect(() => setSlashHighlight(0), [slashQ, slashCandidates.length]);
  // podświetlenie musi zostać w widoku — lista jest wyższa niż okno dropdownu
  const slashListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    slashListRef.current?.children[slashHighlight]?.scrollIntoView({ block: "nearest" });
  }, [slashHighlight]);

  const pickSlash = (row: SlashRow | undefined) => {
    if (!row) return; // lista mogła się skrócić, zanim Enter doszedł
    // multibot: wiersze z akcją wykonują dispatch i czyszczą pole; pusty tekst
    // sam zamyka picker (slashQuery("") === null)
    if (row.run) {
      row.run();
      setText("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      return;
    }
    const next = `${row.label} `;
    setText(next);
    setCaret(next.length);
    setSlashDismissed(true); // wybór kończy komendę — następny Enter wysyła
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  // multibot: paleta poleceń (CmdK) wstawia komendę skilla tutaj. Zdarzenie, nie
  // stan w reduktorze — treść composera należy do composera, a paleta jest
  // jedynym obcym nadawcą (ten sam wzorzec co `mb:teach:*`).
  //
  // WSTAWIA, NIE WYSYŁA: skill to zwykła wiadomość, którą gateway rozwiązuje z
  // `/nazwa reszta`, więc dotychczasowa treść zostaje jako argumenty zamiast
  // zniknąć. Nasłuch przez ref z pustymi zależnościami — `text` zmienia się przy
  // każdym znaku i na liście zależności przepinałby nasłuch po każdym wciśnięciu
  // klawisza.
  const insertRef = useRef<(command: string) => void>(() => {});
  insertRef.current = (command: string) => {
    const next = withCommand(text, command);
    setText(next);
    setCaret(next.length);
    setSlashDismissed(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.length, next.length);
    });
  };
  useEffect(() => {
    const onInsert = (e: Event) => insertRef.current((e as CustomEvent<string>).detail);
    window.addEventListener("mb:composer:insert", onInsert);
    return () => window.removeEventListener("mb:composer:insert", onInsert);
  }, []);

  const pickMention = (row: MentionRow | undefined) => {
    // lista mogła się skrócić, zanim Enter doszedł (jak w `pickSlash`)
    if (!mention || !row) return;
    // Bot dopełnia tag (@Imię ), skill wstawia komendę — oba od miejsca,
    // gdzie zaczynało się zapytanie po "@"; reszta treści zostaje.
    const insert = row.type === "bot" ? `@${row.peer.name} ` : `${row.skill.command ?? `/${row.skill.name}`} `;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}${insert}${after}`;
    setText(next);
    const newCaret = mention.start + insert.length;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  // multibot: otwarty panel boczny zwęża kolumnę czatu — pigułki idą wtedy
  // na same ikony (patrz sidePanelOpen).
  const pillsCollapsed = sidePanelOpen(state);
  const availableReasoning = reasoningLevels(bot.modelSelection.model);
  const reasoningLabel =
    availableReasoning.find((item) => item.id === reasoning)?.label ?? (polish ? "Domyślny" : "Default");
  const reasoningTitle = `${polish ? "Rozumowanie" : "Reasoning"}: ${reasoningLabel}`;
  const fastAvailable = fastModeAvailable(
    state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.driverKind,
    bot.modelSelection.model,
  );
  useEffect(() => {
    setReasoning((current) => availableReasoning.some((item) => item.id === current) ? current : availableReasoning[0].id);
    setReasoningOpen(false);
  }, [bot.modelSelection.model]);

  useEffect(() => {
    if (!attachOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAttachOpen(false);
    };
    // multibot: menu musi się chować przy tapnięciu obok — na telefonie nie ma
    // Escape, wiszące menu sprawiało, że pierwszy tap na plusa je zamykał
    // zamiast otworzyć (objaw „działa od drugiego kliknięcia", lista zmian 8.14).
    // Mousedown, nie click: zamknięcie zanim zdarzenie doleci do celu, więc
    // ten sam tap normalnie działa tam, gdzie user tapnął.
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("#attachment-menu, [data-attach-toggle]")) return;
      setAttachOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", closeOnOutside);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", closeOnOutside);
    };
  }, [attachOpen]);

  useEffect(() => () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
  }, []);

  const addFiles = useCallback((list: FileList | File[] | null) => {
    if (!list?.length) return;
    setAttachmentError(null);
    const incoming = [...list];
    if (attachments.length + incoming.length > 10) {
      setAttachmentError("Maximum 10 attachments per message.");
      return;
    }
    const tooLarge = incoming.find((file) => file.size > (file.type.startsWith("image/") ? 8 : 25) * 1024 * 1024);
    if (tooLarge) {
      setAttachmentError(`${tooLarge.name} exceeds ${tooLarge.type.startsWith("image/") ? 8 : 25} MB limit.`);
      return;
    }
    setAttachments((current) => [...current, ...incoming.map((file) => {
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (preview) previewUrls.current.add(preview);
      return { id: randomId(), file, preview, status: "ready" as const };
    })]);
    setAttachOpen(false);
  }, [attachments.length]);

  // multibot Zad.3: Ctrl+V / paste obrazów z schowka — bardzo ważne, użytkownik
  // wymaga wklejania zdjęć (screenshot, copy image). Wyciągamy pliki z
  // clipboardData.files oraz clipboardData.items (image/*) i przekazujemy do
  // addFiles. Działa na PC (Chrome/FF) i w WebView jeśli system udostępnia
  // schowek. Nie blokuje wklejania tekstu — tylko gdy są pliki/obrazki.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files: File[] = [];
    if (dt.files?.length) {
      for (const f of Array.from(dt.files)) if (f.size > 0) files.push(f);
    }
    if (dt.items?.length) {
      for (const item of Array.from(dt.items)) {
        if (item.kind !== "file") continue;
        if (item.type && !item.type.startsWith("image/")) continue;
        const f = item.getAsFile();
        if (f && !files.some((x) => x.name === f.name && x.size === f.size && x.type === f.type)) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  // desktop drag&drop: ChatView dispatches File[] when user drops onto chat
  useEffect(() => {
    const onDropFiles = (e: Event) => {
      const files = (e as CustomEvent<File[]>).detail;
      if (!files?.length) return;
      addFiles(files);
    };
    window.addEventListener("mb:composer:addFiles", onDropFiles as EventListener);
    return () => window.removeEventListener("mb:composer:addFiles", onDropFiles as EventListener);
  }, [addFiles]);

  const removeAttachment = (id: string) => setAttachments((current) => current.filter((item) => {
    if (item.id === id && item.preview) {
      URL.revokeObjectURL(item.preview);
      previewUrls.current.delete(item.preview);
    }
    return item.id !== id;
  }));

  const send = async () => {
    // multibot 0.1.44: brak blokady `bot.busy` — wiadomości w trakcie tury
    // kolejkują się po stronie serwera i bot odpowiada raz na wszystkie.
    if ((!text.trim() && !attachments.length) || uploading) return;
    setUploading(true);
    setAttachmentError(null);
    try {
      const attachmentIds = await Promise.all(attachments.map(async (item) => {
        setAttachments((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "uploading" } : candidate));
        const response = await authFetch(`/api/bots/${bot.id}/attachments`, {
          method: "POST",
          headers: {
            "content-type": item.file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(item.file.name),
          },
          body: item.file,
        });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Upload failed (HTTP ${response.status})`);
        return String((await response.json()).id);
      }));
      if (onSend) {
        if (!onSend(text.trim())) return;
      } else dispatch({
        type: "send",
        botId: bot.id,
        text: text.trim(),
        attachmentIds,
        ...(reasoning !== "default" ? { reasoning } : {}),
      });
      track("message_sent", { driver: bot.modelSelection?.instanceId });
      setText("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      previewUrls.current.clear();
      setAttachments([]);
    } catch (error) {
      setAttachments((current) => current.map((item) => item.status === "uploading" ? { ...item, status: "error" } : item));
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    // multibot: Web Speech owns this recording when the bridge is absent
    if (webSpeechActive) return;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 1) {
        setSpeechError(
          "Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording]);

  const toggleMic = () => {
    if (!secureContext && !window.ogb) {
      setSpeechError("Dictation is unavailable over plain HTTP. Open this app on localhost or HTTPS (for example Tailscale).");
      return;
    }
    // multibot: bridge first (packaged app), Web Speech in plain browsers
    if (webSpeechActive) {
      baseText.current = text.trim();
      setRecording((r) => !r);
      return;
    }
    if (!window.ogb) {
      setSpeechError("Voice input needs the desktop app — run pnpm dev:desktop.");
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  return (
    <div className="px-5 pb-5 pt-2">
      {!secureContext && !window.ogb && (
        <div className="mb-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          Dictation needs a secure context: use HTTPS or localhost. Plain HTTP on a LAN cannot access the microphone.
        </div>
      )}
      {speechError && (
        <div className="mb-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      {attachmentError && (
        <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {attachmentError}
        </div>
      )}
      <div className="relative w-full">
        <input ref={filesRef} hidden type="file" multiple onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
        {/* multibot: F8 — picker po "/", ten sam dropdown co @mention; pięć
            kategorii mieści się dzięki przewijaniu i etykiecie typu po prawej */}
        {slashOpen && (
          <div ref={slashListRef} className="absolute bottom-full left-10 z-20 mb-2 max-h-72 w-80 overflow-y-auto rounded-xl border border-hairline/40 bg-raised shadow-lg">
            {slashCandidates.map((row, i) => (
              <button
                key={row.id}
                onClick={() => pickSlash(row)}
                onMouseEnter={() => setSlashHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === slashHighlight ? "bg-raised-hover" : "",
                )}
              >
                <span className="flex size-6 shrink-0 items-center justify-center text-ink-secondary">
                  {row.icon ?? SLASH_ICON[row.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{row.label}</span>
                  {row.hint && (
                    <span className="block truncate text-xs text-ink-secondary">{row.hint}</span>
                  )}
                </span>
                <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">
                  {SLASH_TYPE[row.kind][polish ? 1 : 0]}
                </span>
              </button>
            ))}
          </div>
        )}
        {pickerOpen && (
          <div className="absolute bottom-full left-10 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg">
            {candidates.map((row, i) => (
              <button
                key={row.type === "bot" ? row.peer.id : `s-${row.skill.name}`}
                onClick={() => pickMention(row)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                {row.type === "bot" ? (
                  <>
                    <MausAvatar color={row.peer.color} shape={row.peer.mascotShape} state={normalizeState(row.peer.mascotExpression) ?? "happy"} size={24} animated={false} />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{botDisplayName(row.peer, polish ? "pl" : "en")}</span>
                    <span className="shrink-0 text-xs text-ink-secondary">{polish ? "Bot" : "Agent"}</span>
                  </>
                ) : (
                  <>
                    {/* multibot: skill wyróżnia się kolorem akcentu — ikona i
                        komenda, żeby na liście obok botów od razu rzucał się
                        w oczy jak przy tworzeniu umiejętności */}
                    <span className="flex size-6 shrink-0 items-center justify-center">
                      <Wand2 size={15} className="text-accent" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-accent">{row.skill.command ?? `/${row.skill.name}`}</span>
                      {row.skill.description && (
                        <span className="block truncate text-xs text-ink-secondary">{row.skill.description}</span>
                      )}
                    </span>
                    <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">
                      {polish ? "Umiejętność" : "Skill"}
                    </span>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2" aria-label={polish ? "Załączniki gotowe do wysłania" : "Attachments ready to send"}>
            {/* multibot: szkic używa tej samej karty co wysłany plik — inaczej
                ten sam załącznik wyglądał inaczej przed wysłaniem i po nim.
                Podmieniamy tylko ikonę (miniatura obrazka) i akcję (usuń). */}
            {attachments.map((item) => (
              <div key={item.id} className="w-64">
                <AttachmentCard
                  name={item.file.name}
                  size={item.file.size}
                  icon={item.preview ? <img src={item.preview} alt="" className="size-9 shrink-0 rounded-lg object-cover" /> : undefined}
                  action={item.status === "uploading" ? <Loader2 size={16} className="shrink-0 animate-spin text-ink-secondary" /> : (
                    <button type="button" onClick={() => removeAttachment(item.id)} aria-label={`Remove ${item.file.name}`} className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised-hover hover:text-ink">
                      <X size={16} />
                    </button>
                  )}
                />
              </div>
            ))}
          </div>
        )}
        {attachOpen && (
          <div id="attachment-menu" className="absolute bottom-full left-0 z-30 mb-2 min-w-44 overflow-hidden rounded-xl border border-hairline/40 bg-card p-1 shadow-xl" role="menu">
            {[
              { label: polish ? "Pliki" : "Files", icon: FileIcon, action: () => { filesRef.current?.click(); setAttachOpen(false); } },
            ].map(({ label, icon: Icon, action }) => (
              <button key={label} type="button" role="menuitem" onClick={action} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-raised">
                <Icon size={16} className="text-ink" /> {label}
              </button>
            ))}
          </div>
        )}
        {/* multibot: `gap-1.5` (6 px) zamiast `gap-2` — 8 px odstępu plus po
            8 px wewnętrznego paddingu z każdej strony pigułki dawało między
            samymi ikonami ~24 px pustki i rząd wyglądał na rozstrzelony
            (Kacper). Zwinięte pigułki są teraz kwadratami 32 px jak mikrofon
            i spinacz, więc cały rząd trzyma jeden rytm. */}
        <div className="relative flex min-h-12 items-center gap-1.5 rounded-2xl border border-hairline/40 bg-raised/60 py-2 pl-3 pr-2.5">
        {/* Pasek: maksymalnie jeden bot, animowany, i tylko gdy ma co pokazać. */}
        {strip && (
          <div className="pointer-events-none absolute bottom-[calc(100%+8px)] left-0 z-20 hidden size-[40px] items-center justify-center md:flex" title={botDisplayName(bot, polish ? "pl" : "en")}>
            <MausAvatar
              color={bot.color}
              avatarUrl={bot.avatarUrl}
              shape={bot.mascotShape}
              state={strip}
              size={40}
              animated
            />
          </div>
        )}
        {/* Czat grupowy nie ma jednego wlasciciela pliku, a `onSend` niesie sam
            tekst - lepiej nie pokazywac spinacza niz zzerac zalacznik. */}
        {!onSend && (
        <button
          type="button"
          data-attach-toggle
          onClick={() => setAttachOpen((open) => !open)}
          aria-expanded={attachOpen}
          aria-haspopup="menu"
          aria-controls="attachment-menu"
          disabled={bot.busy || uploading}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
          title={polish ? "Dołącz" : "Attach"}
        >
          <Plus size={20} />
        </button>
        )}
        <textarea
          data-composer-input
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            const el = e.target;
            setText(el.value);
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
            setCaret(el.selectionStart ?? el.value.length);
            setDismissedAt(null);
            setSlashDismissed(false); // multibot: F8 — Esc chowa picker tylko do następnej zmiany
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            // multibot: F8 — nawigacja pickera skilli; rozłączny z @mention
            // (slash tylko, gdy cała treść to "/token"), więc bez kolizji gałęzi
            if (slashOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setSlashHighlight((h) => (h + delta + slashCandidates.length) % slashCandidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickSlash(slashCandidates[slashHighlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashDismissed(true);
                return;
              }
            }
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
            if (e.key === "Escape" && attachOpen) setAttachOpen(false);
            if (e.key === "Escape" && recording) setRecording(false);
          }}
          onPaste={handlePaste}
          placeholder={
            recording ? polish ? "Słucham…" : "Listening…" : bot.busy ? polish ? `${botDisplayName(bot, polish ? "pl" : "en")} pracuje…` : `${botDisplayName(bot, polish ? "pl" : "en")} is working…` : polish ? `Wiadomość do ${botDisplayName(bot, polish ? "pl" : "en")}` : `Message ${botDisplayName(bot, polish ? "pl" : "en")}`
          }
          // multibot: pole rosło bez sufitu — wysokość leci na `scrollHeight`,
          // a `overflow-hidden` nie dawał czego przewijać, więc długa
          // wiadomość (albo Shift+Enter w kółko) wypychała czat z ekranu.
          // `max-h-64` przycina wzrost, `overflow-y-auto` daje pasek. Bez
          // liczenia sufitu w JS: styl wpisany na sztywno i tak jest zacięty
          // przez `max-height`.
          className="max-h-64 w-full resize-none overflow-y-auto bg-transparent py-1 text-[15px] leading-5 text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <div className="relative shrink-0">
          <button
            onClick={() => setReasoningOpen((open) => !open)}
            aria-expanded={reasoningOpen}
            // multibot: poziom MUSI siedzieć w `aria-label`, nie tylko w `title`.
            // aria-label wygrywa nazwę dostępną i spycha `title` do roli opisu,
            // którego duża część czytników nie czyta — a przy zwiniętej pigułce
            // to jedyne miejsce, z którego da się poznać ustawiony poziom.
            aria-label={reasoningTitle}
            className={cn(
              "flex shrink-0 items-center rounded-full text-[11px] font-medium text-ink-secondary hover:bg-raised hover:text-ink",
              composerPillShape(pillsCollapsed),
            )}
            title={reasoningTitle}
          >
            <Brain size={15} />
            {/* multibot: przy otwartym panelu bocznym kolumna czatu robi się
                wąska i podpis poziomu wypychał resztę wiersza — zostaje sama
                ikona, a poziom mówi dymek i etykieta dla czytników
                (Kacper 29.08, rozszerzone na wszystkie panele boczne). */}
            {!pillsCollapsed && <span>{reasoningLabel}</span>}
          </button>
          {reasoningOpen && (
            <div className="absolute bottom-full right-0 z-30 mb-2 min-w-32 overflow-hidden rounded-xl border border-hairline/40 bg-card p-1 shadow-xl">
              {availableReasoning.map((item) => (
                <button
                  key={item.id}
                  onClick={() => { setReasoning(item.id); setReasoningOpen(false); }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[12px] text-ink",
                    reasoning === item.id ? "bg-raised" : "hover:bg-raised/60",
                  )}
                >
                  {item.label}
                  {reasoning === item.id && <span className="text-accent">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* multibot: „Fast mode" — ustawienie bota (przeżywa restart), nie wybór
            na turę jak poziom rozumowania. Tylko codex: to jego service tier
            `priority`, w subskrypcji ChatGPT bez dopłaty, ale szybciej zjada limit. */}
        {fastAvailable && (
          <button
            onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { fastMode: !bot.fastMode } })}
            aria-pressed={bot.fastMode === true}
            aria-label={polish ? "Tryb szybki" : "Fast mode"}
            className={cn(
              "flex shrink-0 items-center rounded-full text-[11px] font-medium",
              composerPillShape(pillsCollapsed),
              bot.fastMode ? "bg-raised text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={
              polish
                ? `Tryb szybki: ${bot.fastMode ? "włączony" : "wyłączony"} — 1,5x szybciej, szybciej zjada limit`
                : `Fast mode: ${bot.fastMode ? "on" : "off"} — 1.5x speed, increased usage`
            }
          >
            <Zap size={15} />
            {!pillsCollapsed && <span>{polish ? "Szybko" : "Fast"}</span>}
          </button>
        )}
        {/* multibot: szybki przełącznik dostępu bota, obok poziomu rozumowania */}
        <ComposerAccessPill bot={bot} collapsed={pillsCollapsed} />
        <button
          onClick={toggleMic}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full",
            recording
              ? "animate-pulse bg-danger/20 text-danger"
              : "text-ink-secondary hover:bg-raised hover:text-ink",
          )}
          title={recording ? polish ? "Zatrzymaj dyktowanie (Esc)" : "Stop dictation (Esc)" : polish ? "Dyktuj" : "Dictate"}
        >
          <Mic size={18} />
        </button>
        {/* multibot 0.1.44: Send zawsze widoczny po prawej; stop/kwadrat wyleciały —
            przerywanie tury robi panel komputera i zatwierdzenia, nie composer. */}
        <button
          onClick={() => void send()}
          disabled={uploading || (!text.trim() && !attachments.length)}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 active:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
          title={polish ? "Wyślij" : "Send"}
          aria-label={polish ? "Wyślij" : "Send"}
        >
          <ArrowUp size={16} />
        </button>
        </div>
      </div>
    </div>
  );
}
