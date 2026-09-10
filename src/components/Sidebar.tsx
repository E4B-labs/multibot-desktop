import { track } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot as BotIcon,
  BellDot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCopy,
  Copy,
  Crown,
  EyeOff,
  FolderPlus,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Plug,
  Trash2,
  Users,
} from "lucide-react";
import { useStore, formatTime, type Bot, type EngineGroup } from "@/state/store";
import { Skeleton } from "./Loading";
import { BotAvatar, InitialsAvatar } from "./Avatar";
import { ScoutTeamModal } from "./ScoutTeamModal";
import { sidebarAvatarProps, stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { plainPreview } from "@/lib/plainPreview";
import { authFetch } from "@/lib/auth";
// multibot: F11 — status silnika dla warunkowej kropki w stopce
import { getLanguage, useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import { groupAvatarLayout, type GroupAvatarLayout, groupRowTitle, MAX_GROUP_MEMBERS } from "@/lib/groupRow";
// multibot: kolejność sekcji i podział wierszy — czysta logika, testowana osobno
import { moveSectionTo, sectionRows } from "@/lib/sidebarSections";
// multibot: czerwony wykrzyknik na ikonie ustawień — jest widoczna aktualizacja
import { useUpdaterState } from "@/lib/updater";
// multibot: wspólna mechanika zmiany szerokości — szyna i panele po prawej
import { ResizeHandle, useResizableWidth } from "./ResizablePanel";

const isElectron = navigator.userAgent.includes("Electron");

const DEFAULT_SIDEBAR_WIDTH = 240;
const COLLAPSED_SIDEBAR_WIDTH = 80;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 420;
const COLLAPSE_THRESHOLD = 112;
const SIDEBAR_WIDTH_KEY = "multibot.sidebarWidth";
const SIDEBAR_EXPANDED_WIDTH_KEY = "multibot.sidebarExpandedWidth";

export function clampSidebarWidth(width: number): number {
  if (width <= COLLAPSE_THRESHOLD) return COLLAPSED_SIDEBAR_WIDTH;
  return Math.min(Math.max(Math.round(width), MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);
}

/** Awatar w pasku bocznym — helper mieszka w `@/lib/mascot`, bo naglowek
 * czatu trzyma sie tej samej zasady. Reeksport, zeby importy nie ruszaly. */
export { sidebarAvatarProps };

/**
 * Awatar czlonka grupy w stosie na wierszu grupy — dokladnie ta sama zasada
 * co wiersz bota: stoi, dopoki bot nie pracuje.
 */
export function groupMemberAvatarProps(bot: Bot) {
  return sidebarAvatarProps(bot);
}

function readSidebarWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null || raw.trim() === "") return fallback;
    const stored = Number(raw);
    return Number.isFinite(stored) ? clampSidebarWidth(stored) : fallback;
  } catch {
    return fallback;
  }
}

/** Two name words → initials, first email character → initial, unset → "?". */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

function preview(bot: Bot): string {
  if (bot.busy) return getLanguage() === "pl" ? "Pracuje…" : "Working…";
  const last = bot.messages[bot.messages.length - 1];
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return "Screen frame";
  // A bot↔bot exchange is a chip with no text of its own; without this the
  // sidebar row goes blank for the whole length of the conversation.
  if (last.kind === "room" && last.room) {
    const pl = getLanguage() === "pl";
    return last.room.event === "replied"
      ? (pl ? "Kolega odpisał" : "A colleague replied")
      : (pl ? "Napisał do kolegi" : "Texted a colleague");
  }
  // multibot: bot pisze markdownem, a to jest jedna linia zwykłego tekstu —
  // bez tego na liście widać `## Raport` i `**Pies**` zamiast treści.
  return last.text ? plainPreview(last.text) : "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

// multibot 0.1.49: kafelek po najechaniu na bota (styl Groka) — awatar + nazwa,
// pod nimi opis albo ostatnie zadanie, obok godzina ostatniej wiadomości.
// Fixed zamiast absolute: lista ma overflow-y-auto, które przycina absoluty.
interface HoverState {
  botId: string;
  top: number;
  left: number;
}

interface GroupMenuState {
  group: EngineGroup;
  x: number;
  y: number;
}

function BotContextMenu({
  menu,
  onClose,
  onMoveToSection,
}: {
  menu: MenuState;
  onClose: () => void;
  /** multibot: sekcje sidebaru (port z upstreamu #296) */
  onMoveToSection?: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  // keep the menu on-screen near the click
  const top = Math.min(menu.y, window.innerHeight - 340);
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? polish ? "Odepnij" : "Unpin" : polish ? "Przypnij" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(
          <FolderPlus size={16} className="text-ink-secondary" />,
          bot.section ? polish ? "Zmień sekcję" : "Change section" : polish ? "Przenieś do sekcji" : "Move to section",
          () => onMoveToSection?.(bot.id),
        ),
        item(<BellDot size={16} className="text-ink-secondary" />, polish ? "Oznacz jako nieprzeczytane" : "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, polish ? "Edytuj profil" : "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, polish ? "Duplikuj" : "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, polish ? "Kopiuj ID rozmowy" : "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(<EyeOff size={16} className="text-ink-secondary" />, polish ? "Ukryj na pasku bocznym" : "Hide from sidebar", () =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { hidden: true } }),
        ),
        item(<Trash2 size={16} />, polish ? "Usuń" : "Delete", () => dispatch({ type: "deleteBot", botId: bot.id }), {
          danger: true,
        }),
      ]}
    </div>
  );
}

// multibot: własne typy przeciągania w sidebarze. Cel sprawdza je w `dragover`
// — obcy tekst czy link nie ma prawa udawać wiersza ani sekcji.
const SIDEBAR_DRAG_TYPES = ["text/mb-section", "text/mb-group-id", "text/mb-bot-id"] as const;

// multibot: nagłówek sekcji na liście (port z upstreamu #296). Wysokość i
// marginesy są STAŁE (`h-9`, zero paddingu pionowego) — wcześniej `pt-3 pb-1`
// dawało inny odstęp nad pierwszą sekcją niż między kolejnymi, więc kilka
// zwiniętych nagłówków obok siebie wyglądało na krzywo poukładane. Odstępy
// robi wyłącznie `gap-0.5` listy, tak samo dla wiersza bota, grupy i nagłówka.
function SectionDivider({
  name,
  collapsed,
  onToggle,
  onMenu,
  onDropBot,
  onDropGroup,
  onDropSection,
  polish,
}: {
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  onMenu: (menu: { name: string; x: number; y: number }) => void;
  onDropBot: (botId: string, section: string) => void;
  onDropGroup: (groupId: string, section: string) => void;
  onDropSection: (moved: string, target: string) => void;
  polish: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <button
      type="button"
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ name, x: e.clientX, y: e.clientY });
      }}
      // multibot: nagłówek jest i uchwytem (kolejność sekcji), i celem —
      // upuszczony bot albo grupa wpada do sekcji, upuszczona sekcja staje na
      // tym miejscu. Przyjmujemy WYŁĄCZNIE własne typy: bez tego przeciągnięty
      // z zewnątrz tekst albo link wyglądałby na poprawny cel, a upuszczenie
      // poleciałoby PATCH-em na nieistniejące id.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/mb-section", name);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!SIDEBAR_DRAG_TYPES.some((type) => e.dataTransfer.types.includes(type))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDragEnd={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // Payload czytamy dopiero tutaj — w `dragover` przeglądarka go chowa.
        const moved = e.dataTransfer.getData("text/mb-section").trim();
        if (moved) {
          if (moved !== name) onDropSection(moved, name);
          return;
        }
        const groupId = e.dataTransfer.getData("text/mb-group-id").trim();
        if (groupId) {
          onDropGroup(groupId, name);
          return;
        }
        const botId = e.dataTransfer.getData("text/mb-bot-id").trim();
        if (botId) onDropBot(botId, name);
      }}
      aria-expanded={!collapsed}
      aria-label={collapsed ? polish ? `Rozwiń sekcję ${name}` : `Expand section ${name}` : polish ? `Zwiń sekcję ${name}` : `Collapse section ${name}`}
      title={collapsed ? polish ? "Rozwiń sekcję" : "Expand section" : polish ? "Zwiń sekcję" : "Collapse section"}
      className={cn(
        "flex h-9 w-full shrink-0 items-center gap-2 rounded-lg px-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        dragOver ? "bg-raised ring-1 ring-accent" : "hover:bg-raised/40",
      )}
    >
      {collapsed ? <ChevronRight size={14} className="shrink-0 text-ink-secondary" /> : <ChevronDown size={14} className="shrink-0 text-ink-secondary" />}
      <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{name}</span>
      <span className="h-px flex-1 bg-hairline/40" />
    </button>
  );
}

/** Menu kontekstowe nagłówka sekcji: przestawienie w górę/w dół. */
function SectionMenu({
  menu,
  canUp,
  canDown,
  onMove,
  onClose,
  polish,
}: {
  menu: { name: string; x: number; y: number };
  canUp: boolean;
  canDown: boolean;
  onMove: (delta: -1 | 1) => void;
  onClose: () => void;
  polish: boolean;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-section-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const top = Math.min(menu.y, window.innerHeight - 110);
  const left = Math.min(menu.x, window.innerWidth - 216);
  const item = (icon: React.ReactNode, label: string, enabled: boolean, delta: -1 | 1) => (
    <button
      disabled={!enabled}
      onClick={() => {
        onMove(delta);
        onClose();
      }}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink",
        enabled ? "hover:bg-raised/70" : "cursor-default opacity-40",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      data-section-menu
      style={{ top, left }}
      className="fixed z-40 w-[204px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {item(<ChevronUp size={16} className="text-ink-secondary" />, polish ? "Przenieś wyżej" : "Move up", canUp, -1)}
      {item(<ChevronDown size={16} className="text-ink-secondary" />, polish ? "Przenieś niżej" : "Move down", canDown, 1)}
    </div>
  );
}

/** Popover „przenieś do sekcji": istniejące sekcje jako chips, pole na nową,
 * usunięcie z sekcji. Sam tylko dispatchuje updateBot. */
function SectionPicker({
  botId,
  anchor,
  onClose,
}: {
  botId: string;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [draft, setDraft] = useState("");
  const bot = state.bots.find((b) => b.id === botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  const top = Math.min(anchor.y, window.innerHeight - 300);
  const left = Math.min(anchor.x, window.innerWidth - 250);
  const names = [...new Set(state.bots.map((b) => b.section?.trim()).filter((s): s is string => Boolean(s)))];
  // multibot: czyszczenie jedzie jako null (nie undefined) — JSON.stringify
  // wycina undefined i pole nigdy nie dotarłoby do PATCH-a
  const assign = (section: string | null) => {
    dispatch({ type: "updateBot", botId, patch: { section } });
    onClose();
  };

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className="fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-card p-1.5 shadow-2xl shadow-black/60"
    >
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {polish ? "Sekcje" : "Sections"}
      </div>
      {names.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1 pb-1">
          {names.map((name) => (
            <button
              key={name}
              onClick={() => assign(name)}
              className={cn(
                "rounded-full border border-hairline/50 px-2 py-1 text-[12px]",
                bot.section === name ? "bg-accent text-white" : "text-ink hover:bg-raised",
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim().slice(0, 60);
          if (name) assign(name);
        }}
        className="flex gap-1 px-1 py-1"
      >
        <input
          autoFocus
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={polish ? "Nowa sekcja…" : "New section…"}
          className="min-w-0 flex-1 rounded-lg bg-inset px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label={polish ? "Dodaj do sekcji" : "Add to section"}
          className="shrink-0 rounded-lg bg-raised px-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          ✓
        </button>
      </form>
      {bot.section && (
        <button
          onClick={() => assign(null)}
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
        >
          <FolderPlus size={14} className="rotate-180" />
          {polish ? "Usuń z sekcji" : "Remove from section"}
        </button>
      )}
    </div>
  );
}

// Kafelek hovera: te same klasy co menu kontekstowe, ale pointer-events-none —
// musnięcie kafelka nie może go zgasić. Pozycję liczy Sidebar (clamp do viewportu).
function BotHoverCard({ bot, top, left }: { bot: Bot; top: number; left: number }) {
  const lang = useLanguage();
  const last = bot.messages[bot.messages.length - 1];
  return (
    <div
      style={{ top, left }}
      className="pointer-events-none fixed z-50 w-72 rounded-xl border border-hairline/50 bg-card p-3 shadow-2xl shadow-black/60"
    >
      <div className="flex items-center gap-2">
        <BotAvatar color={bot.color} avatarUrl={bot.avatarUrl} shape={bot.mascotShape} state={stateForBot(bot)} size={28} animated={false} />
        {/* godzina na wysokości nazwy; flex-1 na nazwie trzyma ją przy prawej
            krawędzi kafelka (ta sama oś X co wcześniej) */}
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{botDisplayName(bot, lang)}</span>
        {last && <span className="shrink-0 text-[11px] text-ink-secondary">{formatTime(last.at)}</span>}
      </div>
      <div className="mt-1.5">
        {/* opis ma pierwszeństwo; bez opisu — ostatnie zadanie/wiadomość (preview) */}
        <span className="line-clamp-2 text-[12.5px] leading-snug text-ink-secondary">
          {bot.description?.trim() || preview(bot)}
        </span>
      </div>
    </div>
  );
}

function BotListItem({
  bot,
  onMenu,
  collapsed,
  onHover,
  onUnhover,
}: {
  bot: Bot;
  onMenu: (menu: MenuState) => void;
  collapsed?: boolean;
  onHover?: (botId: string, rect: DOMRect) => void;
  onUnhover?: () => void;
}) {
  const { state, dispatch } = useStore();
  // U20: zaznaczenie ma być jedno — po otwarciu grupy bot przestaje być
  // podświetlony (inaczej świecą dwa: grupa i ostatni bot).
  const selected = state.selectedId === bot.id && !state.groupOpen;
  const avatar = sidebarAvatarProps(bot);
  const lang = useLanguage();
  const last = bot.messages[bot.messages.length - 1];
  return (
    <button
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
      }}
      // multibot 0.1.46: bota można przeciągnąć na wiersz grupy (filtracja składu)
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/mb-bot-id", bot.id);
        e.dataTransfer.setData("text/plain", bot.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      // multibot 0.1.49: hover card (styl Groka) zamiast natywnego tooltipa —
      // w szynie nazwa wraca w kafelku, nie w title.
      onMouseEnter={(e) => onHover?.(bot.id, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onUnhover?.()}
      // multibot: buźka podąża za kursorem po całym podświetlanym wierszu,
      // nie tylko nad samym awatarem (scope śledzenia — patrz Avatar.tsx).
      data-mb-avatar-scope
      className={cn(
        "flex w-full items-center rounded-xl text-left",
        collapsed ? "relative justify-center px-0 py-1.5" : "gap-3 px-3 py-2.5",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <BotAvatar
        color={bot.color} avatarUrl={bot.avatarUrl}
        shape={bot.mascotShape}
        state={avatar.state}
        size={48}
        motion={avatar.motion}
        motionKey={avatar.motionKey}
        animated={avatar.animated}
        trackPointerWhenPaused
      />
      {/* multibot: nazwa i podgląd znikają w szynie, ale kropka zostaje —
          to jedyny sygnał „coś się tu dzieje", jaki tam przeżył. Ta sama
          zasada pierwszeństwa co niżej: uwaga bije nieprzeczytane. */}
      {collapsed &&
        (bot.needsAttention != null ? (
          <span
            title={bot.needsAttention}
            className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-warning ring-2 ring-panel"
          />
        ) : (
          bot.unread && (
            <span className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-accent ring-2 ring-panel" />
          )
        ))}
      {!collapsed && (
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
           <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
             {bot.chiefOfStaff && <Crown size={12} className="shrink-0 text-accent" aria-label="Section chief" />}
              <span className="truncate">{botDisplayName(bot, lang)}</span>
           </span>
          {last && (
            <span className="shrink-0 text-xs text-ink-secondary">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">
            {preview(bot)}
          </span>
          {/* multibot: needs-attention dot — same pattern as the unread dot below,
              warning color + reason tooltip; wins over unread (more urgent). */}
          {bot.needsAttention != null ? (
            <span
              title={bot.needsAttention}
              className="size-2 shrink-0 rounded-full bg-warning"
            />
          ) : (
            bot.unread && (
              <span className="size-2 shrink-0 rounded-full bg-accent" />
            )
          )}
        </div>
      </div>
      )}
    </button>
  );
}

function GroupContextMenu({ menu, onClose }: { menu: GroupMenuState; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [busy, setBusy] = useState(false);
  // multibot: zmiana nazwy grupy (port z upstreamu #343) — inline input
  // w menu, Enter zapisuje (IME-safe), Escape wraca do pozycji menu.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(menu.group.name || "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-group-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const remove = async () => {
    if (busy || !window.confirm(polish ? `Usunąć grupę „${menu.group.name || menu.group.id}”?` : `Delete “${menu.group.name || menu.group.id}”?`)) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/groups/${encodeURIComponent(menu.group.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      if (state.groupOpen?.id === menu.group.id) dispatch({ type: "toggleGroup", group: null });
      dispatch({ type: "workspaceChanged", botId: "", resource: "groups" });
      onClose();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const top = Math.min(menu.y, window.innerHeight - 90);
  const left = Math.min(menu.x, window.innerWidth - 220);

  const saveRename = async () => {
    const name = draft.trim().slice(0, 100);
    if (!name || name === menu.group.name) return setRenaming(false);
    setBusy(true);
    try {
      const res = await authFetch(`/api/groups/${encodeURIComponent(menu.group.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status} ${res.statusText}`);
      dispatch({ type: "workspaceChanged", botId: "", resource: "groups" });
      onClose();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setBusy(false);
      setRenaming(false);
    }
  };

  const menuItem = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled || busy}
      onClick={() => {
        onClick?.();
        if (!opts?.disabled) onClose();
      }}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      data-group-menu
      style={{ top, left }}
      className="fixed z-40 w-[208px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveRename();
          }}
          className="px-2 py-1"
        >
          <input
            autoFocus
            value={draft}
            maxLength={100}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
            onBlur={() => void saveRename()}
            aria-label={polish ? "Nazwa grupy" : "Group name"}
            className="w-full rounded-lg bg-inset px-2 py-1.5 text-[13px] text-ink outline-none"
          />
        </form>
      ) : (
        <>
          {menuItem(<Pencil size={16} className="text-ink-secondary" />, polish ? "Zmień nazwę" : "Rename", () => {
            setDraft(menu.group.name || "");
            setTimeout(() => setRenaming(true), 0);
          })}
          <button
            onClick={() => void remove()}
            disabled={busy}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-danger/10 disabled:cursor-default disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
            {polish ? "Usuń grupę" : "Delete group"}
          </button>
        </>
      )}
    </div>
  );
}

// multibot: F9-FE — grupy w sidebarze: każdy bot ma trwałą reprezentację
// `mb-<threadId>` w transporcie grupowym, niezależnie od wybranego drivera.
// Jeden GET przy mount — zero pollingu; POST create dopisuje do listy
// lokalnie. `null` = nie załadowano (harness nie odpowiedział).
function useEngineGroups(workspaceVersion: unknown) {
  const [groups, setGroups] = useState<EngineGroup[] | null>(null);
  useEffect(() => {
    let alive = true;
    authFetch("/api/groups")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((gs: EngineGroup[]) => alive && setGroups(gs))
      .catch(() => alive && setGroups([]));
    return () => {
      alive = false;
    };
  }, [workspaceVersion]);
  return [groups, setGroups] as const;
}

/** Pozycje elementów klastra w pudełku 48×48 wiersza grupy — indeks wybiera
 *  slot, plakietka „+N" bierze slot za ostatnim awatarem. Pudełko jest to samo
 *  co przy bocie, więc wiersze mają równą wysokość.
 *
 *  Współrzędne są w pikselach, nie w skoku Tailwinda, bo klaster ma się nakładać
 *  o ~25%: element ma 24 px, sąsiedzi stoją co 18 px, więc części wspólne mają
 *  po 6 px. Cały klaster (42×42) siedzi wyśrodkowany w pudełku — stąd margines
 *  3 px z każdej strony. Kolejność w DOM = kolejność malowania, więc dalszy
 *  element zawsze leży NA bliższym; żadnego `z-*` tu nie trzeba. */
const GROUP_AVATAR_SLOTS: Record<GroupAvatarLayout, string[]> = {
  solo: ["inset-0"],
  pair: ["left-[3px] top-[12px]", "left-[21px] top-[12px]"],
  trio: ["left-[3px] top-[3px]", "left-[21px] top-[3px]", "left-[12px] top-[21px]"],
};

/** Wiersz grupy. Osobnej sekcji „GRUPY" już nie ma — grupa stoi w liście tam,
 *  gdzie wskazuje jej `section`, dokładnie tak samo jak bot. */
function GroupRow({
  group: g,
  bots,
  collapsed,
  onMenu,
  onUpdated,
}: {
  group: EngineGroup;
  bots: Bot[];
  collapsed?: boolean;
  onMenu: (menu: GroupMenuState) => void;
  onUpdated: (group: EngineGroup) => void;
}) {
  const { state, dispatch } = useStore();
  const lang = useLanguage();
  const [dragOver, setDragOver] = useState(false);

  // multibot 0.1.46: upuszczenie bota na wiersz grupy dopisuje go do składu.
  // Nieudane dopisanie musi być widać — inaczej wygląda identycznie jak udane
  // (wiersz nie ma gdzie pokazać komunikatu, więc idzie alertem jak przy
  // usuwaniu grupy).
  const dropBot = async (botId: string) => {
    setDragOver(false);
    try {
      const res = await authFetch(`/api/groups/${encodeURIComponent(g.id)}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      onUpdated(body as EngineGroup);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const members = g.bot_ids
    .map((id) => bots.find((b) => "mb-" + b.threadId === id))
    .filter((b): b is Bot => b != null);
  const { layout, shown, hiddenCount } = groupAvatarLayout(members, g.bot_ids.length);
  const last = g.messages?.[g.messages.length - 1];
  const attention = members.find((b) => b.needsAttention != null)?.needsAttention;

  return (
    <button
      onClick={() => dispatch({ type: "toggleGroup", group: g })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ group: g, x: e.clientX, y: e.clientY });
      }}
      // multibot: wiersz grupy da się przeciągnąć na nagłówek sekcji — bez tego
      // sekcja wybrana przy tworzeniu byłaby nie do zmiany.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/mb-group-id", g.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setDragOver(false)}
      onDragOver={(e) => {
        // tylko bot dopisuje się do składu; przeciągana sekcja czy grupa nie
        if (!e.dataTransfer.types.includes("text/mb-bot-id")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        const bid = e.dataTransfer.getData("text/mb-bot-id").trim();
        if (bid) void dropBot(bid);
        else setDragOver(false);
      }}
      title={g.name || g.id}
      // multibot: scope śledzenia buźki tylko dla grupy z JEDNYM awatarem —
      // stos kilku awatarów zostaje przy starym śledzeniu nad samym awatarem.
      data-mb-avatar-scope={layout === "solo" ? "" : undefined}
      className={cn(
        "relative flex w-full items-center rounded-xl text-left",
        collapsed ? "justify-center px-0 py-1.5" : "gap-3 px-3 py-2.5",
        dragOver ? "bg-raised ring-1 ring-accent" : state.groupOpen?.id === g.id ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      {members.length > 0 ? (
        <span className="relative size-12 shrink-0">
          {shown.map((member, index) => (
            // Klucz z indeksem, bo stare grupy mogą nieść ten sam bot_id dwa razy
            // (dedup wszedł dopiero teraz, po stronie serwera).
            // `flex` nie jest ozdobą: bez niego slot jest inline i łapie 6 px
            // zejścia linii pod awatarem, więc awatar 24 px zajmuje 24×30 i
            // rozjeżdża się z plakietką, która jest blokowa.
            <span key={`${member.id}-${index}`} className={cn("absolute flex", GROUP_AVATAR_SLOTS[layout][index])}>
              <BotAvatar
                color={member.color}
                avatarUrl={member.avatarUrl}
                shape={member.mascotShape}
                size={layout === "solo" ? 48 : 24}
                {...groupMemberAvatarProps(member)}
                trackPointerWhenPaused
              />
            </span>
          ))}
          {hiddenCount > 0 && (
            <span
              role="img"
              aria-label={`${hiddenCount} more group members`}
              // Plakietka jest kolejnym elementem klastra, więc stoi w slocie za
              // ostatnim awatarem i ma dokładnie jego 24 px. `ring-2` rysował się
              // NA ZEWNĄTRZ, przez co plakietka miała 28 px i obwódkę, której
              // żaden awatar nie ma; `border` mieści się w tych samych 24 px.
              className={cn(
                "absolute flex size-6 items-center justify-center rounded-full border border-hairline bg-raised text-[11px] font-semibold text-ink-secondary",
                GROUP_AVATAR_SLOTS[layout][shown.length],
              )}
            >
              +{hiddenCount}
            </span>
          )}
          {attention && (
            <span
              title={attention}
              className="absolute -right-1 -top-1 flex items-center justify-center rounded-full bg-panel text-warning"
            >
              <AlertTriangle size={12} />
            </span>
          )}
        </span>
      ) : (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
          <Users size={20} />
        </span>
      )}
      {!collapsed && (
        <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">
            {groupRowTitle(members.map((b) => botDisplayName(b, lang))) || g.name || g.id}
          </span>
          {last && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.at)}</span>}
        </div>
      )}
    </button>
  );
}

/** Formularz nowej grupy. Sekcję wybiera się tu (istniejące w `datalist`,
 *  wpisanie nowej też działa); puste pole = obszar bez sekcji. */
function GroupCreateForm({
  bots,
  sections,
  onClose,
  onCreated,
}: {
  bots: Bot[];
  sections: string[];
  onClose: () => void;
  onCreated: (group: EngineGroup) => void;
}) {
  const { dispatch } = useStore();
  const lang = useLanguage();
  const polish = lang === "pl";
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (engineBotId: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(engineBotId)) next.delete(engineBotId);
      else if (next.size < MAX_GROUP_MEMBERS) next.add(engineBotId);
      return next;
    });

  const create = async () => {
    if (busy || !name.trim() || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const bot_ids = bots.map((b) => `mb-${b.threadId}`).filter((id) => picked.has(id));
      const res = await authFetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), bot_ids, section: section.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof body.detail === "string" ? body.detail : undefined;
        throw new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`);
      }
      const group = body as EngineGroup;
      onCreated(group);
      onClose();
      setName("");
      setSection("");
      setPicked(new Set());
      dispatch({ type: "toggleGroup", group });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-1 mt-1 flex flex-col gap-2 rounded-xl bg-card p-3">
      <input
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        placeholder={polish ? "Nazwa grupy" : "Group name"}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        list="mb-group-sections"
        maxLength={60}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        placeholder={polish ? "Sekcja (opcjonalnie)" : "Section (optional)"}
        aria-label={polish ? "Sekcja grupy" : "Group section"}
        value={section}
        onChange={(e) => setSection(e.target.value)}
      />
      <datalist id="mb-group-sections">
        {sections.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {bots.map((b) => {
          const engineBotId = `mb-${b.threadId}`;
          return (
            <label
              key={b.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-[13px] text-ink hover:bg-raised/50"
            >
              <input
                type="checkbox"
                checked={picked.has(engineBotId)}
                onChange={() => toggle(engineBotId)}
                className="accent-accent"
                disabled={!picked.has(engineBotId) && picked.size >= MAX_GROUP_MEMBERS}
              />
              <span className="truncate">{botDisplayName(b, lang)}</span>
            </label>
          );
        })}
      </div>
      {/* Przy 12/12 pola wyboru gasną — licznik jest jedynym wyjaśnieniem, więc
          czytnik ekranu musi go usłyszeć bez wracania kursorem. */}
      <div aria-live="polite" className="text-[11px] text-ink-secondary">
        {picked.size}/{MAX_GROUP_MEMBERS}
      </div>
      {error && <div className="text-[12px] text-danger">{error}</div>}
      <div className="flex gap-2">
        <button
          onClick={() => void create()}
          disabled={busy || !name.trim() || picked.size === 0}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {polish ? "Utwórz" : "Create"}
        </button>
        <button
          onClick={() => {
            onClose();
            setError(null);
          }}
          className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
        >
          {polish ? "Anuluj" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

/** multibot: czerwony wykrzyknik w prawym górnym rogu ikony ustawień —
 *  widnieje, dopóki jest aktualizacja dostępna albo gotowa do restartu.
 *  Powiadomienia bez .lnk-owych baniek: same ikony, zero nakładek na tekst. */
function UpdateBadge() {
  const s = useUpdaterState();
  if (!s || (s.status !== "available" && s.status !== "downloaded" && s.status !== "downloading")) return null;
  const label = s.status === "available"
    ? "Update available"
    : "Update downloading";
  return (
    <span
      aria-hidden
      className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-danger text-[10px] font-bold leading-none text-danger-ink"
      title={label}
    >
      !
    </span>
  );
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const lang = useLanguage();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [scoutOpen, setScoutOpen] = useState(false);
  // multibot 0.1.49: kafelek hovera — timer 350 ms gasi migotanie przy
  // przejeżdżaniu myszką przez listę; wyjazd z wiersza kasuje go natychmiast.
  const [hover, setHover] = useState<HoverState | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHoverCard = (botId: string, rect: DOMRect) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // clamp do viewportu: szerokość w-72 (288 px), wysokość ~120 px
    const top = Math.max(8, Math.min(rect.top - 4, window.innerHeight - 128));
    const left = Math.min(rect.right + 10, window.innerWidth - 296);
    hoverTimer.current = setTimeout(() => setHover({ botId, top, left }), 350);
  };
  const hideHoverCard = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(null);
  };
  // multibot: ta sama mechanika co panele po prawej (ResizablePanel), tylko
  // z własnym domknięciem — szyna zwija się do ikon poniżej progu, więc
  // `clamp` idzie z zewnątrz zamiast prostego min/max.
  const resize = useResizableWidth(SIDEBAR_WIDTH_KEY, {
    defaultWidth: DEFAULT_SIDEBAR_WIDTH,
    min: COLLAPSED_SIDEBAR_WIDTH,
    max: MAX_SIDEBAR_WIDTH,
    side: "right",
    label: polish ? "Zmień szerokość panelu botów" : "Resize bot panel",
    clamp: clampSidebarWidth,
  });
  const sidebarWidth = resize.width;
  const setSidebarWidth = resize.setWidth;
  const resizing = resize.resizing;
  const expandedWidth = useRef(
    Math.max(MIN_SIDEBAR_WIDTH, readSidebarWidth(SIDEBAR_EXPANDED_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH)),
  );
  const collapsed = sidebarWidth === COLLAPSED_SIDEBAR_WIDTH;

  useEffect(() => {
    if (collapsed) return;
    expandedWidth.current = sidebarWidth;
    try {
      window.localStorage.setItem(SIDEBAR_EXPANDED_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Private browsing/storage-disabled: sidebar still works for this run.
    }
  }, [collapsed, sidebarWidth]);

  // multibot: zwinięcie zamyka wysuwane menu, obojętne czy zwinął je
  // użytkownik, czy zwężone okno. Szyna je i tak przestaje rysować, ale bez
  // tego wracają otwarte przy rozwinięciu — jakby wyskoczyły same.
  useEffect(() => {
    if (!collapsed) return;
    setAddMenuOpen(false);
    setGroupCreateOpen(false);
  }, [collapsed]);

  // multibot: otwarty bot zostaje NA SWOIM MIEJSCU w liście pod wyszukiwarką.
  // Wcześniej dostawał osobny wiersz nad paskiem wyszukiwania i wypadał z listy,
  // więc samo wybranie bota wyrzucało go ponad wyszukiwarkę, a lista pod spodem
  // przeskakiwała o jedną pozycję.
  //
  // Sortujemy WYŁĄCZNIE po przypięciu. Wcześniej kluczem był jeszcze `unread`,
  // ale otwarcie bota gasi ten znacznik (src/state/store.tsx), więc wybranie
  // nieprzeczytanego bota spychało go w dół — czyli dokładnie ten ruch, który
  // miał zniknąć. Sort w JS jest stabilny, więc poza przypiętymi kolejność
  // zostaje taka, jaka przyszła z serwera, i nie zmienia się przy klikaniu.
  const visibleBots = state.bots
    .filter((b) => !b.hidden)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  // multibot: sekcje sidebaru (port z upstreamu #296) — przypięte zostają na
  // górze bez podziałów; reszta dzieli się na „bez sekcji" i sekcje w
  // kolejności zapisanej na serwerze. W zwiniętej szynie podziałów nie rysujemy.
  const [sectionPicker, setSectionPicker] = useState<{ botId: string; x: number; y: number } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const toggleSection = (name: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const unpinned = visibleBots.filter((b) => !b.pinned);
  // multibot: przypięty bot — duży awatar 1:1 pod wyszukiwarką, bez szpilki (wzór z foty)
  const pinnedBots = visibleBots.filter((b) => b.pinned);
  // multibot: F9-FE — kandydaci do grup: cała flota, także ukryci. Kolejność
  // stabilna z listy botów; wybrany driver nie usuwa bota z grup.
  const groupBots = state.bots;
  const [groups, setGroups] = useEngineGroups(state.workspaceVersion);
  const groupList = groups ?? [];
  // multibot: kolejność sekcji trzyma serwer (`/api/config`), więc desktop i
  // telefon układają listę tak samo; nowe sekcje dopisują się na końcu.
  const savedOrder = state.config?.sectionOrder ?? [];
  const rows = sectionRows(unpinned, groupList, savedOrder);
  const sectionNames = rows.sections.map((s) => s.name);
  const saveOrder = (next: string[]) => {
    void authFetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // multibot: zapis jest PODMIANĄ całej listy, więc doklejamy nazwy, których
      // ta sesja nie rysuje (sekcja z samymi przypiętymi/ukrytymi botami, sekcja
      // cudzych botów, sekcja grup zanim `/api/groups` odpowie). Bez tego każde
      // przestawienie kasowałoby je ze wspólnej kolejności.
      body: JSON.stringify({ sectionOrder: [...next, ...savedOrder.filter((name) => !next.includes(name))] }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((config) => config && dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };
  const moveSection = (name: string, index: number) => saveOrder(moveSectionTo(sectionNames, name, index));
  // multibot: przeniesienie grupy do sekcji — harnessowy PATCH, silnik o
  // sekcjach nie wie (server/index.ts, trasa `/api/groups/:id`).
  const moveGroupToSection = async (groupId: string, section: string) => {
    try {
      const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ section }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      if (body.group) setGroups((gs) => (gs ?? []).map((x) => (x.id === groupId ? (body.group as EngineGroup) : x)));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };
  // multibot: przypięte nie siedzą już w liście — mają osobny header nad nią
  const flatBots = collapsed ? visibleBots : rows.unsectioned.bots;

  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-add-menu]")) setAddMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAddMenuOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [addMenuOpen]);

  return (
    <aside
      // multibot: ta sama krzywa i czas co `--animate-panel-in`, żeby szyna
      // rozwijała się tak samo jak panele po prawej. `panel-in` to keyframe
      // od zamontowania, więc szerokości nie da się nim animować.
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden border-r border-hairline/40 bg-panel",
        !resizing && "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        "w-[var(--sidebar-width)]",
      )}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <ResizeHandle resize={resize} />
      {/* Titlebar: real traffic lights in Electron, faux ones in the browser.
          multibot: data-shell-rail-top = przy oknie bez ramki ten rząd rośnie
          o 4 px, żeby jego przyciski stanęły w linii z kontrolkami okna
          (src/styles.css) */}
      <div
        data-shell-rail-top
        className={cn(
          "flex items-center px-4 pt-3.5 pb-1",
          collapsed ? "justify-center" : "justify-between",
        )}
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {!collapsed && (
          isElectron ? (
            <div className="w-14" />
          ) : (
            <div className="flex items-center gap-2">
              <span className="size-3 rounded-full bg-[#ff5f57]" />
              <span className="size-3 rounded-full bg-[#febc2e]" />
              <span className="size-3 rounded-full bg-[#28c840]" />
            </div>
          )
        )}
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              if (collapsed) setSidebarWidth(expandedWidth.current);
              else setSidebarWidth(COLLAPSED_SIDEBAR_WIDTH);
            }}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title={polish ? (collapsed ? "Rozwiń panel" : "Zwiń panel") : collapsed ? "Expand panel" : "Collapse panel"}
            aria-label={polish ? (collapsed ? "Rozwiń panel" : "Zwiń panel") : collapsed ? "Expand panel" : "Collapse panel"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen size={20} strokeWidth={2} /> : <PanelLeftClose size={20} strokeWidth={2} />}
          </button>
          {!collapsed && (
            <div className="relative" data-add-menu>
              <button
                onClick={() => setAddMenuOpen((v) => !v)}
                className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                title={polish ? "Dodaj bota albo grupę" : "Add bot or group"}
                aria-expanded={addMenuOpen}
              >
                <Plus size={20} strokeWidth={2} />
              </button>
              {addMenuOpen && (
                <div className="absolute right-0 top-8 z-30 w-44 rounded-xl border border-hairline/40 bg-card p-1.5 shadow-lg">
                  <button
                    onClick={() => {
                      track("bot_created");
                      setAddMenuOpen(false);
                      dispatch({ type: "newBot", visibility: "team" });
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
                  >
                    <BotIcon size={15} className="text-ink-secondary" />
                    {polish ? "Nowy bot zespołowy" : "New team bot"}
                  </button>
                  <button
                    onClick={() => {
                      track("bot_created");
                      setAddMenuOpen(false);
                      dispatch({ type: "newBot", visibility: "private" });
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
                  >
                    <BotIcon size={15} className="text-ink-secondary" />
                    {polish ? "Nowy bot prywatny" : "New private bot"}
                  </button>
                  <button
                    onClick={() => {
                      setAddMenuOpen(false);
                      setGroupCreateOpen(true);
                    }}
                    disabled={groupBots.length === 0}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Users size={15} className="text-ink-secondary" />
                    {polish ? "Nowa grupa" : "New group"}
                  </button>
                  <button
                    onClick={() => {
                      setAddMenuOpen(false);
                      setScoutOpen(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
                  >
                    <FolderPlus size={15} className="text-ink-secondary" />
                    {polish ? "Zespół z folderu" : "Scout from folder"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Search — multibot: data-shell-rail-search oddaje te 4 px, o które
          urósł rząd nad nim, żeby pole zostało dokładnie tam, gdzie było */}
      {!collapsed && (
        <div data-shell-rail-search className="px-3 pt-2 pb-3">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => window.dispatchEvent(new CustomEvent("mb:cmdk:open"))}
            className="flex w-full items-center gap-2 rounded-lg bg-raised/70 px-3 py-2 text-left hover:bg-raised"
          >
            <Search size={16} className="shrink-0 text-ink-secondary" />
            <span className="flex-1 truncate text-[14px] text-ink-secondary">{polish ? "Szukaj" : "Search"}</span>
            <kbd className="shrink-0 rounded border border-hairline/60 px-1.5 py-0.5 text-[10px] text-ink-secondary">Ctrl K</kbd>
          </button>
        </div>
      )}

      {/* Pinned — podział na rzędy po max 3; ułożenie każdego rzędu zależy
          od liczby awatarów w TYM rzędzie (1: wycentrowany; 2: wycentrowana
          para; 3: siatka 3 kolumny). Hover z opisem jak reszta botów. */}
      {!collapsed && pinnedBots.length > 0 && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {Array.from(
            { length: Math.ceil(pinnedBots.length / 3) },
            (_, rowIndex) => pinnedBots.slice(rowIndex * 3, rowIndex * 3 + 3),
          ).map((rowBots, rowIndex) => (
            <div
              key={rowIndex}
              className={cn(
                "gap-2",
                rowBots.length === 1
                  ? "flex justify-center"
                  : rowBots.length === 2
                    ? "flex justify-center"
                    : "grid grid-cols-3",
              )}
            >
              {rowBots.map((b) => {
                const isSelected = state.selectedId === b.id && !state.groupOpen;
                const avatarSize = sidebarWidth < 280 ? 56 : 72;
                return (
                  <button
                    key={b.id}
                    onClick={() => dispatch({ type: "select", id: b.id })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ botId: b.id, x: e.clientX, y: e.clientY });
                    }}
                    onMouseEnter={(e) => showHoverCard(b.id, e.currentTarget.getBoundingClientRect())}
                    onMouseLeave={() => hideHoverCard()}
                    // multibot: cały podświetlany kafelek to scope śledzenia buźki.
                    data-mb-avatar-scope
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-2xl px-2 py-2",
                      isSelected ? "bg-raised" : "hover:bg-raised/50",
                    )}
                  >
                    <BotAvatar
                      color={b.color} avatarUrl={b.avatarUrl}
                      shape={b.mascotShape}
                      size={avatarSize}
                      {...sidebarAvatarProps(b)}
                      trackPointerWhenPaused
                    />
                    <span className="w-full truncate text-center text-[12px] font-medium leading-tight text-ink">
                      {botDisplayName(b, lang)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Unified conversation list: group rows sit with bots, above plugins. */}
      <div
        className={cn("flex-1 overflow-y-auto", collapsed ? "px-1 pt-2" : "px-2")}
      >
        {/* multibot: jedna kolumna z jednym `gap-0.5` na wszystko — wiersz
            bota, wiersz grupy i nagłówek sekcji dostają ten sam odstęp, więc
            kilka zwiniętych nagłówków obok siebie stoi równo. */}
        <div className="flex flex-col gap-0.5">
          {!state.hydrated && state.bots.length === 0 &&
            [0, 1, 2, 3, 4].map((i) => <Skeleton key={`bot-skeleton-${i}`} className="h-9 w-full" />)}
          {flatBots.map((b) => (
            <BotListItem
              key={b.id}
              bot={b}
              onMenu={setMenu}
              collapsed={collapsed}
              onHover={showHoverCard}
              onUnhover={hideHoverCard}
            />
          ))}
          {groups === null && state.hydrated && <Skeleton className="h-9 w-full" />}
          {(collapsed ? groupList : rows.unsectioned.groups).map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              bots={groupBots}
              collapsed={collapsed}
              onMenu={setGroupMenu}
              onUpdated={(next) => setGroups((gs) => (gs ?? []).map((x) => (x.id === next.id ? next : x)))}
            />
          ))}
          {!collapsed &&
            rows.sections.map((section) => (
              <div key={section.name} className="flex flex-col gap-0.5">
                <SectionDivider
                  name={section.name}
                  collapsed={collapsedSections.has(section.name)}
                  onToggle={() => toggleSection(section.name)}
                  onMenu={setSectionMenu}
                  onDropBot={(botId, name) => dispatch({ type: "updateBot", botId, patch: { section: name } })}
                  onDropGroup={(groupId, name) => void moveGroupToSection(groupId, name)}
                  onDropSection={(moved, target) => moveSection(moved, sectionNames.indexOf(target))}
                  polish={polish}
                />
                {!collapsedSections.has(section.name) && (
                  <>
                    {section.bots.map((b) => (
                      <BotListItem
                        key={b.id}
                        bot={b}
                        onMenu={setMenu}
                        collapsed={collapsed}
                        onHover={showHoverCard}
                        onUnhover={hideHoverCard}
                      />
                    ))}
                    {section.groups.map((g) => (
                      <GroupRow
                        key={g.id}
                        group={g}
                        bots={groupBots}
                        collapsed={collapsed}
                        onMenu={setGroupMenu}
                        onUpdated={(next) => setGroups((gs) => (gs ?? []).map((x) => (x.id === next.id ? next : x)))}
                      />
                    ))}
                  </>
                )}
              </div>
            ))}
          {groupCreateOpen && !collapsed && (
            <GroupCreateForm
              bots={groupBots}
              sections={sectionNames}
              onClose={() => setGroupCreateOpen(false)}
              onCreated={(group) => setGroups((gs) => [...(gs ?? []), group])}
            />
          )}
        </div>
      </div>

      {/* Footer */}
      <div className={cn("pb-3 pt-2", collapsed ? "px-1" : "px-3")}>
        {/* multibot: Rozmowy botów i Mapa zespołu przeniesione do 3-kropek
            w nagłówku czatu (prawy górny róg) — tu celowo puste. */}
        <button
          onClick={() => dispatch({ type: "togglePlugins", open: true })}
          title={collapsed ? (polish ? "Wtyczki" : "Plugins") : undefined}
          className={cn(
            "flex w-full items-center rounded-xl gap-3 px-3 py-2 text-left hover:bg-raised/50",
            collapsed ? "justify-center px-0" : "",
          )}
        >
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#151515] text-ink-secondary">
            <Plug size={18} />
          </span>
            {!collapsed && <span className="text-[14px] font-semibold text-ink">{polish ? "Wtyczki" : "Plugins"}</span>}
        </button>
        {/* multibot: w szynie nazwa użytkownika znika, a ustawienia aplikacji
            zostają — awatar profilu bez nazwy nic nie wnosi, a koło zębate
            jest jedynym wejściem w ustawienia. */}
        {collapsed ? (
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="inline-flex size-8 items-center justify-center rounded-md p-0 text-ink-secondary hover:bg-raised hover:text-ink"
            title={polish ? "Ustawienia aplikacji" : "App settings"}
          >
            <span className="relative inline-flex">
              <Settings size={20} />
              <UpdateBadge />
            </span>
          </button>
        ) : (
        <div className="flex items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left">
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={32} />
            <span className="truncate text-[14px] font-semibold text-ink">
              {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
            </span>
          </div>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="inline-flex size-8 items-center justify-center rounded-md p-0 text-ink-secondary hover:bg-raised hover:text-ink"
            title={polish ? "Ustawienia aplikacji" : "App settings"}
          >
            <span className="relative inline-flex">
              <Settings size={18} />
              <UpdateBadge />
            </span>
          </button>
        </div>
        )}
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
        />
      )}
      {groupMenu && <GroupContextMenu menu={groupMenu} onClose={() => setGroupMenu(null)} />}
      {sectionPicker && <SectionPicker botId={sectionPicker.botId} anchor={sectionPicker} onClose={() => setSectionPicker(null)} />}
      {sectionMenu && (
        <SectionMenu
          menu={sectionMenu}
          canUp={sectionNames.indexOf(sectionMenu.name) > 0}
          canDown={sectionNames.indexOf(sectionMenu.name) < sectionNames.length - 1}
          onMove={(delta) => moveSection(sectionMenu.name, sectionNames.indexOf(sectionMenu.name) + delta)}
          onClose={() => setSectionMenu(null)}
          polish={polish}
        />
      )}
      {scoutOpen && <ScoutTeamModal onClose={() => setScoutOpen(false)} />}
      {hover && (() => {
        const bot = state.bots.find((b) => b.id === hover.botId);
        return bot ? <BotHoverCard bot={bot} top={hover.top} left={hover.left} /> : null;
      })()}
    </aside>
  );
}
