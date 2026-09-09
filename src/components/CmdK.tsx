// multibot: Cmd+K (macOS) / Ctrl+K command palette. Overlay follows the
// Onboarding pattern (fixed inset-0 + z-50 on app tokens), rows follow the
// Composer @mention picker. Actions are generated from what the store REALLY
// exposes: select / newBot / toggleSettings / toggleComputer /
// toggleAppSettings / togglePlugins. Fuzzy filter = plain case-insensitive
// subsequence match, no libraries.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Eye, FileText, GraduationCap, Link2, ListTodo, MessageSquare, Monitor, Plus, Puzzle, Search, Settings, SlidersHorizontal, Users, Wand2, Wrench } from "lucide-react";
import { useStore } from "@/state/store";
import { LoadingRow } from "./Loading";
import { BotAvatar } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import { autocompleteBots } from "@/lib/botAutocomplete";

/** Subsequence match: every query char appears, in order, in the target. */
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return true;
  const t = target.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  run: () => void;
  /** Etykieta typu przy prawej krawędzi, jak w wierszach wyszukiwania. */
  badge?: string;
}

/** Kształt z GET /api/bots/{id}/skills — to samo źródło, z którego korzystają panel Umiejętności i picker "/" w Composerze. */
interface PaletteSkill {
  name: string;
  command: string;
  description: string;
}

type SearchKind = "all" | "message" | "agent" | "group" | "file" | "link" | "routine" | "skill" | "action";
interface SearchResult {
  id: string;
  kind: Exclude<SearchKind, "all" | "action">;
  title: string;
  subtitle: string;
  at?: number;
  botId?: string;
  groupId?: string;
  href?: string;
}

const TABS: Array<{ id: SearchKind; en: string; pl: string }> = [
  { id: "all", en: "All", pl: "Wszystko" },
  { id: "message", en: "Messages", pl: "Wiadomości" },
  { id: "agent", en: "Agents", pl: "Agenci" },
  { id: "group", en: "Groups", pl: "Grupy" },
  { id: "file", en: "Files", pl: "Pliki" },
  { id: "link", en: "Links", pl: "Linki" },
  { id: "routine", en: "Routines", pl: "Rutyny" },
  { id: "action", en: "Actions", pl: "Akcje" },
];

function resultIcon(kind: SearchResult["kind"]) {
  if (kind === "message") return <MessageSquare size={15} />;
  if (kind === "agent") return <Wrench size={15} />;
  if (kind === "group") return <Users size={15} />;
  if (kind === "file") return <FileText size={15} />;
  if (kind === "link") return <Link2 size={15} />;
  if (kind === "routine") return <ListTodo size={15} />;
  return <Wrench size={15} />;
}

function resultType(kind: SearchResult["kind"], polish: boolean): string {
  const labels: Record<SearchResult["kind"], [string, string]> = {
    message: ["Message", "Wiadomość"], agent: ["Agent", "Agent"], group: ["Group", "Grupa"],
    file: ["File", "Plik"], link: ["Link", "Link"], routine: ["Routine", "Rutyna"], skill: ["Skill", "Umiejętność"],
  };
  return labels[kind][polish ? 1 : 0];
}

export function CmdK() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<SearchKind>("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // multibot: bot ukryty na pasku bocznym nie miał jak wrócić — filtr `!hidden`
  // jest jedyną listą botów w aplikacji, więc „Ukryj" było jednokierunkowe.
  // Paleta jest tu naturalnym miejscem: tryb zamiast osobnego panelu.
  const [showHidden, setShowHidden] = useState(false);

  // Meta+K on macOS, Ctrl+K everywhere. preventDefault is mandatory —
  // Chrome otherwise steals Ctrl+K for the address bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      // Esc closes even when focus wandered off the input (no-op when closed)
      if (e.key === "Escape") setOpen(false);
    };
    // multibot: pole „Szukaj" na pasku bocznym otwiera tę samą paletę. Skrót
    // Ctrl+K jest niewidoczny, a tamto pole i tak nic nie robiło.
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mb:cmdk:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mb:cmdk:open", onOpen);
    };
  }, []);

  // fresh palette on every open
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setTab("all");
      setShowHidden(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Search durable server records only after the user types; empty palette
  // stays instant and shows local actions/bots.
  useEffect(() => {
    if (!open || !query.trim() || tab === "action") {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void authFetch(`/api/search?q=${encodeURIComponent(query)}&type=${tab}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((body: { results?: SearchResult[] }) => setResults(body.results ?? []))
        .catch(() => { if (!controller.signal.aborted) setResults([]); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 140);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query, tab]);

  const current = state.bots.find((b) => b.id === state.selectedId);

  // multibot: skille żyją w harnessie per bot (`/api/bots/{id}/skills`, to samo
  // źródło co panel Umiejętności i picker "/" w Composerze). Otwarta grupa je
  // gasi: wstawiamy komendę do composera czatu bota, a przy grupie to nie jest
  // ten sam composer. Cache trzyma id bota — przełączenie bota odświeża listę.
  const [skills, setSkills] = useState<{ botId: string; rows: PaletteSkill[] } | null>(null);
  useEffect(() => {
    if (!open || state.groupOpen || current == null || skills?.botId === current.id) return;
    let alive = true;
    void authFetch(`/api/bots/${current.id}/skills`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((rows: PaletteSkill[]) =>
        alive && setSkills({ botId: current.id, rows: Array.isArray(rows) ? rows : [] }),
      )
      .catch(() => alive && setSkills({ botId: current.id, rows: [] }));
    return () => {
      alive = false;
    };
  }, [open, state.groupOpen, current, skills]);

  const commands = useMemo<Command[]>(() => {
    const close = (fn: () => void) => () => {
      fn();
      setOpen(false);
    };
    // W trybie ukrytych lista botów odwraca filtr, a kliknięcie odkrywa i
    // przełącza. `updateBot` jedzie PATCH-em na serwer, tak samo jak „Ukryj",
    // więc bot nie wraca do ukrycia po przeładowaniu.
    const hiddenMode = showHidden;
    const cmds: Command[] = state.bots
      .filter((b) => Boolean(b.hidden) === hiddenMode)
      .map((b) => ({
        id: `bot:${b.id}`,
        label: b.name,
        hint: hiddenMode
          ? (polish ? "Odkryj i otwórz" : "Unhide and open")
          : b.id === state.selectedId
            ? (polish ? "Bieżący" : "Current bot")
            : (polish ? "Przełącz" : "Switch to bot"),
        icon: (
          <BotAvatar color={b.color} avatarUrl={b.avatarUrl} shape={b.mascotShape} state={normalizeState(b.mascotExpression) ?? "happy"} size={22} animated={false} />
        ),
        run: close(() => {
          if (hiddenMode) dispatch({ type: "updateBot", botId: b.id, patch: { hidden: false } });
          dispatch({ type: "select", id: b.id });
        }),
      }));
    if (hiddenMode) return cmds;
    cmds.push({
      id: "new-bot",
      label: polish ? "Nowy bot" : "New bot",
      hint: polish ? "Utwórz" : "Create",
      icon: <Plus size={16} />,
      run: close(() => dispatch({ type: "newBot" })),
    });
    // panel actions that need a bot exist only when one is selected —
    // Shell renders SettingsPanel/ComputerPanel only when `bot` is truthy
    if (current) {
      cmds.push({
        id: "settings",
        label: `${polish ? "Ustawienia bota" : "Bot settings"} — ${botDisplayName(current, polish ? "pl" : "en")}`,
        hint: polish ? "Panel" : "Panel",
        icon: <Settings size={16} />,
        run: close(() => dispatch({ type: "toggleSettings", open: true })),
      });
      cmds.push({
        id: "computer",
        label: `${polish ? "Komputer bota" : "Bot's computer"} — ${botDisplayName(current, polish ? "pl" : "en")}`,
        hint: "Panel",
        icon: <Monitor size={16} />,
        run: close(() => dispatch({ type: "toggleComputer", open: true })),
      });
    }
    cmds.push({
      id: "app-settings",
      label: polish ? "Ustawienia aplikacji" : "App settings",
      hint: "Panel",
      icon: <SlidersHorizontal size={16} />,
      run: close(() => dispatch({ type: "toggleAppSettings", open: true })),
    });
    cmds.push({
      id: "plugins",
      label: polish ? "Wtyczki" : "Plugins",
      hint: "Panel",
      icon: <Puzzle size={16} />,
      run: close(() => dispatch({ type: "togglePlugins", open: true })),
    });
    if (current) {
      // Odpowiednik pozycji `learn-from-demonstration` ze spisu: nagrywanie
      // mieszka w karcie pod ekranem komputera, więc paleta tam prowadzi.
      // Osobna akcja, nie skill — na świeżej instalacji żadnych skilli nie ma.
      cmds.push({
        id: "teach",
        label: polish ? "Nagraj umiejętność z demonstracji" : "Learn from demonstration",
        hint: polish ? "Komputer bota" : "Bot's computer",
        icon: <GraduationCap size={16} />,
        run: close(() => dispatch({ type: "toggleComputer", open: true })),
      });
    }
    if (state.bots.some((b) => b.hidden)) {
      cmds.push({
        id: "hidden-bots",
        label: polish ? "Pokaż ukryte boty" : "Open hidden bots",
        hint: polish ? "Pasek boczny" : "Sidebar",
        icon: <Eye size={16} />,
        run: () => {
          setShowHidden(true);
          setQuery("");
          setHighlight(0);
        },
      });
    }
    // Skille NIE uruchamiają się z palety — wstawiają komendę do composera, tak
    // samo jak picker "/". Skill bywa akcją ze skutkami ubocznymi i nie może
    // wystartować od jednego Entera w wyszukiwarce.
    for (const skill of (skills != null && skills.botId === current?.id ? skills.rows : [])) {
      const command = skill.command || `/${skill.name}`;
      cmds.push({
        id: `skill:${skill.name}`,
        label: command,
        hint: skill.description || skill.name,
        badge: polish ? "Umiejętność" : "Skill",
        icon: <Wand2 size={16} />,
        run: close(() => window.dispatchEvent(new CustomEvent("mb:composer:insert", { detail: command }))),
      });
    }
    return cmds;
  }, [state.bots, state.selectedId, current, dispatch, polish, showHidden, skills]);

  const faceBots = useMemo(() => autocompleteBots(query, state.bots), [query, state.bots]);
  const visible = useMemo(() => {
    const faceBotIds = new Set(faceBots.map((bot) => bot.id));
    return commands.filter((command) => command.id.startsWith("bot:") && query.trim()
      ? faceBotIds.has(command.id.slice(4))
      : fuzzyMatch(query, command.label));
  }, [commands, query, faceBots]);

  useEffect(() => setHighlight(0), [query]);

  const openResult = (result: SearchResult) => {
    if (result.href) window.open(result.href, "_blank", "noopener,noreferrer");
    if (result.botId) {
      dispatch({ type: "select", id: result.botId });
      if (result.kind === "routine") dispatch({ type: "toggleRoutines", open: true });
      if (result.kind === "skill") dispatch({ type: "toggleSkills", open: true });
    }
    if (result.groupId) {
      void authFetch(`/api/groups/${encodeURIComponent(result.groupId)}`)
        .then((response) => response.ok ? response.json() : null)
        .then((group) => group && dispatch({ type: "toggleGroup", group }));
    }
    setOpen(false);
  };

  const rows = showHidden
    ? visible
    : tab === "action" || (!query.trim() && tab === "all") ? visible : tab === "all" ? [...visible, ...results] : results;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-app/80 pt-[18vh]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[560px] max-w-[calc(100vw-40px)] animate-pop-in overflow-hidden rounded-2xl border border-hairline/40 bg-panel shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!rows.length) return;
              const delta = e.key === "ArrowDown" ? 1 : -1;
              setHighlight((h) => (h + delta + rows.length) % rows.length);
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const row = rows[highlight];
              if (row && "run" in row) row.run();
              else if (row) openResult(row);
            }
          }}
          placeholder={polish ? "Szukaj wiadomości, botów i działań…" : "Search messages, bots and actions…"}
          className="w-full border-b border-hairline/30 bg-transparent px-4 py-3 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        {showHidden ? (
          <div className="flex items-center justify-between border-b border-hairline/30 px-4 py-2 text-[12px] text-ink-secondary">
            <span>{polish ? "Ukryte boty" : "Hidden bots"}</span>
            <button type="button" onClick={() => setShowHidden(false)} className="rounded-md px-2 py-0.5 hover:bg-raised hover:text-ink">
              {polish ? "Wróć" : "Back"}
            </button>
          </div>
        ) : (
        <div className="flex gap-1 overflow-x-auto border-b border-hairline/30 px-3 py-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-[11px]",
                tab === item.id ? "bg-ink text-app" : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
            >
              {polish ? item.pl : item.en}
            </button>
          ))}
        </div>
        )}
        <div className="max-h-[320px] overflow-y-auto py-1.5">
          {rows.length === 0 && (searching
            ? <LoadingRow label={polish ? "Szukam…" : "Searching…"} className="px-4" />
            : <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-ink-secondary"><Search size={14} />{polish ? "Brak wyników" : "No results"}</div>
          )}
          {rows.map((row, i) => {
            if ("run" in row) {
              return <button key={row.id} onClick={row.run} onMouseEnter={() => setHighlight(i)} className={cn("flex w-full items-center gap-2.5 px-4 py-2 text-left", i === highlight ? "bg-raised-hover" : "")}>
                <span className="flex size-6 shrink-0 items-center justify-center text-ink-secondary">{row.icon}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{row.label}</span>
                <span className="min-w-0 shrink truncate text-xs text-ink-secondary">{row.hint}</span>
                {row.badge && (
                  <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">{row.badge}</span>
                )}
              </button>;
            }
            const bot = row.botId ? state.bots.find((item) => item.id === row.botId) : undefined;
            return <button key={row.id} onClick={() => openResult(row)} onMouseEnter={() => setHighlight(i)} className={cn("flex w-full items-center gap-2.5 px-4 py-2 text-left", i === highlight ? "bg-raised-hover" : "")}>
              <span className="flex size-6 shrink-0 items-center justify-center text-ink-secondary">{bot ? <BotAvatar color={bot.color} avatarUrl={bot.avatarUrl} shape={bot.mascotShape} state={normalizeState(bot.mascotExpression) ?? "happy"} size={22} animated={false} /> : resultIcon(row.kind)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium text-ink">{row.title}</span><span className="block truncate text-[11px] text-ink-secondary">{row.subtitle}</span></span>
              <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">{resultType(row.kind, polish)}</span>
              {row.at ? <span className="shrink-0 text-[10px] text-ink-secondary">{new Date(row.at).toLocaleDateString(polish ? "pl-PL" : "en-US")}</span> : null}
            </button>;
          })}
        </div>
      </div>
    </div>
  );
}
