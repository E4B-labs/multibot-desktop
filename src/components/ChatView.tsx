import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Bell, CalendarClock, ChevronDown, Crosshair, File as FileIcon, Loader2, Monitor, ScanSearch, Search, Upload, Wand2 } from "lucide-react";
// multibot: wspólna pigułka zdarzenia i wspólna karta pliku
import { EventChip } from "./EventChip";
import { SkillRef } from "./SkillRef";
import { AttachmentCard } from "./AttachmentCard";
// multibot: lightbox załączników-obrazków (port z OpenMausBot #436)
import { AttachmentPreviewDialog } from "./AttachmentPreview";
// multibot: pasek szukania w transkrypcie (port z OpenMausBot #437)
import { ChatFindBar } from "./ChatFindBar";
// multibot: flat replies — cytowanie wiadomości (port z OpenMausBot #437)
import { ReplyQuote, replyTargetOf } from "./ReplyQuote";
import { routineStartName, slashCommandLabel } from "@/lib/transcriptChips";
import { useStore, type Bot, type Message } from "@/state/store";
import { formatPeerEnvelope, parsePeerEnvelope } from "@/lib/peerEnvelope";
import { PeerBadge } from "./PeerBadge";
import { formatChatSessionTime, shouldStartChatSession } from "@/lib/chatSessions";
import { MausAvatar } from "./Avatar";
import { sidebarAvatarProps, stateForBot } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard } from "./OptionCard";
import { ComputerHandoffCard } from "./ComputerHandoffCard";
import { ConnectCard } from "./ConnectCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { Composer } from "./Composer";
// multibot: TTS głośniczek przy wiadomościach bota (tylko z kluczem TTS)
import { SpeakButton } from "./SpeakButton";
import { ModelPicker } from "./ModelPicker";
import { ChatHeaderMenu } from "./ChatHeaderMenu";
// multibot: czwarta kopia tej samej linii (App.tsx, Onboarding.tsx,
// Sidebar.tsx). Tu decyduje o jednym: czy pięć akcji bota chowa się pod „⋮".
const isElectron = navigator.userAgent.includes("Electron");
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import { authFetch } from "@/lib/auth";
import { peerActivityGroupFor } from "@/lib/peerActivity";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

function MessageAttachment({ botId, file }: { botId: string; file: NonNullable<Message["attachments"]>[number] }) {
  const [url, setUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    authFetch(`/api/bots/${botId}/attachments/${file.id}`)
      .then((response) => response.ok ? response.blob() : Promise.reject())
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [botId, file.id]);

  if (file.mime.startsWith("image/")) {
    return url ? (
      <>
        {/* multibot: klik otwiera lightbox; pobieranie przeniosłem do dialogu */}
        <button type="button" onClick={() => setPreviewOpen(true)} className="block cursor-zoom-in">
          <img src={url} alt={file.name} className="max-h-64 w-auto max-w-full rounded-xl object-contain" />
        </button>
        {previewOpen && (
          <AttachmentPreviewDialog url={url} name={file.name} onClose={() => setPreviewOpen(false)} />
        )}
      </>
    ) : <div className="h-24 w-40 animate-pulse rounded-xl bg-raised" />;
  }
  return (
    <div className="flex items-center gap-2">
      {/* multibot: karta pliku wspólna dla załączników użytkownika i bota */}
      <div className="min-w-0 flex-1">
        <AttachmentCard name={file.name} size={file.size} url={url} />
      </div>
      {file.mime === "text/html" && (
        <button
          type="button"
          disabled={!url}
          onClick={() => url && window.open(url, "_blank", "noopener,noreferrer")}
          className="shrink-0 rounded-xl bg-raised px-3 py-2 text-sm text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          Otwórz
        </button>
      )}
    </div>
  );
}

/** multibot (F12): badge modelu przy wiadomości. Szuka ładnej etykiety w
 * katalogu instancji (id → label, np. "claude-opus-5" → "Opus 5"); jak nie
 * znajdzie, pokazuje surowe id. Użyty model leci z serwera na wiadomości. */
function ModelBadge({ model }: { model: string }) {
  const { state } = useStore();
  const label =
    state.instances
      .flatMap((instance) => instance.models.options)
      .find((option) => option.id === model)?.label ?? model;
  return (
    <span
      className="mb-1.5 inline-flex max-w-full items-center gap-1 truncate rounded-full border border-hairline/40 bg-raised/60 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary"
      title={model}
    >
      <span className="size-1 shrink-0 rounded-full bg-accent" />
      {label}
    </span>
  );
}

function Bubble({
  botId,
  message,
  highlighted,
  replyTarget,
  replyBotName,
  onJumpTo,
}: {
  botId: string;
  message: Message;
  highlighted?: boolean;
  /** multibot: wiadomość cytowana przez tę wiadomość (flat reply) */
  replyTarget?: Message;
  /** nazwa bota do etykiety cytatu („Replying to Atlas") */
  replyBotName?: string;
  onJumpTo?: (id: string) => void;
}) {
  const polish = useLanguage() === "pl";
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  // multibot: koperta rozmowy bot↔bot — patrz lib/peerEnvelope.ts. Rozbieramy
  // ją przy wyświetlaniu, bo silnik musi dostać kopertę w całości.
  // `text` idzie do TTS i do liczenia długości dymka, więc zostaje sklejone;
  // do rysowania bierzemy nadawcę osobno, bo dostaje plakietkę z awatarem.
  const envelope = parsePeerEnvelope(message.text ?? "");
  const text = formatPeerEnvelope(message.text ?? "");
  const body = envelope ? envelope.body : text;
  const collapsible =
    user && !expanded && (text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES);
  return (
    // multibot: group/msg reveals the SpeakButton (TTS) on bubble hover;
    // data-mb-msg = kotwica dla find-in-chat
    <div
      data-mb-msg={message.id}
      className={cn(
        "group/msg flex w-full rounded-2xl transition-shadow",
        user ? "justify-end" : "justify-start",
        highlighted ? "ring-2 ring-accent/70" : "",
      )}
    >
      <div
        className={cn(
          // multibot: dymek szeroki (90%) — poprzednie 35% było dla właściciela
          // za wąskie, 29.08 poprosił o niemal pełną szerokość kolumny czatu,
          // z niewielkim marginesem. Rozmiar czcionki ustawiał iteracyjnie:
          // 15 → 11 → 17 → 13 → 15 → 14px, a interlinia zeszła z `leading-relaxed`
          // (1.625) na 1.45: przy otwartym panelu bota kolumna jest wąska i
          // rozstrzelony tekst mieścił po trzy słowa w wierszu.
          //
          // multibot: `min-w-0 break-words` = koniec poziomego paska w czacie.
          // Dymek jest elementem flexa, a taki ma `min-width:auto`, więc NIE
          // kurczy się poniżej swojej szerokości min-content — jeden długi token
          // bez spacji (URL, ścieżka, base64) rozpychał dymek ponad te 90%,
          // wiersz `w-full` wystawał poza listę i lista dostawała suwak poziomy.
          // `min-w-0` zdejmuje blokadę, `break-words` łamie sam token.
          // `overflow-wrap` dziedziczy się w dół, więc obejmuje też markdown;
          // bloki kodu zostają nietknięte, bo `white-space:pre` nie zawija.
          "min-w-0 max-w-[90%] break-words rounded-2xl px-2 py-[5px] text-[14px] leading-[1.45]",
          user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
          message.pending && "opacity-60",
        )}
      >
        {message.model && <ModelBadge model={message.model} />}
        {replyTarget && (
          <ReplyQuote
            compact
            message={replyTarget}
            botName={replyBotName}
            onJump={() => onJumpTo?.(replyTarget.id)}
          />
        )}
        {!!message.attachments?.length && message.attachments.some((f) => f.name.toLowerCase() !== "skill.md") && (
          <div className={cn("flex flex-col gap-2", text && "mb-2")}>
            {message.attachments.filter((f) => f.name.toLowerCase() !== "skill.md").map((file) => <MessageAttachment key={file.id} botId={botId} file={file} />)}
          </div>
        )}
        {user ? (
          <>
            <div
              className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
            >
              {envelope && <PeerBadge name={envelope.from} />}
              {body}
            </div>
            {/* multibot: skalowane tym samym wsp. co reszta treści dymka */}
            {collapsible && (
              <button onClick={() => setExpanded(true)} className="mt-1 text-[13px] text-ink-secondary hover:text-ink">
                {polish ? "Pokaż całą wiadomość" : "Show full message"}
              </button>
            )}
          </>
        ) : (
          <ChatMarkdown text={text} compact />
        )}
        {/* multibot: sterowanie hover zostaje w stopce dymka; czas sesji
            renderuje się osobno między wiadomościami. */}
        <div className={cn("mt-1 flex items-center gap-1.5 text-[10px] leading-none", user ? "justify-end" : "justify-start")}>
          {/* multibot: TTS — see SpeakButton.tsx; renders null with no voice key */}
          {!user && <SpeakButton text={text} />}
        </div>
      </div>
    </div>
  );
}

function SessionSeparator({ at, polish }: { at: number; polish: boolean }) {
  const label = formatChatSessionTime(at, polish);
  return (
    <div className="flex w-full justify-center py-4 text-[11px] font-medium text-ink-secondary/75" role="separator" aria-label={label}>
      {label}
    </div>
  );
}

function EventPill({ message, polish }: { message: Message; polish: boolean }) {
  const { dispatch } = useStore();
  if (!message.event) return null;
  // przypomnienie jest rutyną z jednorazową datą, więc prowadzi w to samo miejsce
  const routineEvent = message.event.type === "routine-created" || message.event.type === "reminder-created";
  const labels = polish
    ? { renamed: "Zmieniono nazwę na", "skill-created": "Utworzono umiejętność", "routine-created": "Utworzono rutynę", "reminder-created": "Przypomnienie", "goal-progress": "Cel" }
    : { renamed: "Renamed to", "skill-created": "Created skill", "routine-created": "Created routine", "reminder-created": "Reminder", "goal-progress": "Goal" };
  // multibot: wspólna pigułka zamiast własnego markupu — patrz EventChip.tsx.
  // Rutyna dostaje ikonę zegara, zmiana nazwy zostaje czystym tekstem.
  // skill-created → wyśrodkowany SkillRef: ta sama nazwa, ten sam kolor i ten
  // sam popover co skill wspomniany w zdaniu.
  if (message.event.type === "skill-created") {
    return (
      <div className="flex w-full justify-center py-1">
        <SkillRef name={message.event.value} block />
      </div>
    );
  }
  return (
    <EventChip
      icon={
        message.event.type === "routine-created" ? <CalendarClock size={13} />
          : message.event.type === "reminder-created" ? <Bell size={13} />
            : message.event.type === "goal-progress" ? <Crosshair size={13} /> : undefined
      }
      label={labels[message.event.type]}
      value={message.event.value}
      onClick={routineEvent ? () => dispatch({ type: "toggleRoutines", open: true }) : undefined}
      title={routineEvent ? "Otwórz rutyny / Open routines" : undefined}
    />
  );
}

function PeerActivity({ messages, currentBotId }: { messages: Message[]; currentBotId: string }) {
  const { state } = useStore();
  const polish = useLanguage() === "pl";
  const [expanded, setExpanded] = useState(false);
  const first = messages[0];
  const room = first?.room;
  if (!room?.event) return null;
  const sent = room.event === "texted" && room.ownerBotId === currentBotId;
  const actor = state.bots.find((bot) => bot.id === room.ownerBotId);
  const peerIds = [...new Set(messages.flatMap((message) => message.room?.bot_ids ?? []).filter((id) => id !== room.ownerBotId))];
  const peers = peerIds.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
  const names = peers.map((bot) => botDisplayName(bot, polish ? "pl" : "en"));
  const actorName = actor ? botDisplayName(actor, polish ? "pl" : "en") : room.ownerBotId;
  const label = sent
    ? peers.length === 1
      ? (polish ? `Napisano do ${names[0] ?? room.bot_ids[1] ?? "agenta"}` : `Messaged ${names[0] ?? room.bot_ids[1] ?? "agent"}`)
      : (polish ? `Napisano do ${peers.length} agentów` : `Messaged ${peers.length} agents`)
    : (polish ? `Wiadomość od ${actorName}` : `Message from ${actorName}`);
  const status = state.rooms.find((candidate) => candidate.id === room.id)?.status ?? room.status;
  const statusLabel = status === "done" ? (polish ? "Ukończone" : "Completed") : status === "failed" ? (polish ? "Błąd" : "Failed") : (polish ? "W toku" : "Working");
  const avatars = sent ? [actor, ...peers] : [actor];
  const content = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 -space-x-1">
        {avatars.filter((bot): bot is Bot => Boolean(bot)).slice(0, 3).map((bot) => (
          <MausAvatar key={bot.id} color={bot.color} avatarUrl={bot.avatarUrl} shape={bot.mascotShape} state={stateForBot(bot)} size={20} animated={false} />
        ))}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
  const className = cn(
    "mx-auto flex max-w-full items-center rounded-2xl border px-3 py-2 text-[13px] text-ink-secondary",
    sent && "cursor-pointer hover:text-ink",
    expanded ? "border-[#7d3548]/70 bg-[#351b23] text-ink" : "border-hairline/40 bg-panel",
  );
  return (
    <div className="flex w-full justify-center">
      <div className={cn("max-w-full", expanded && "rounded-2xl border border-[#7d3548]/70 bg-[#351b23]")}>
        {sent ? (
          <button type="button" className={cn(className, expanded && "border-transparent bg-transparent")} onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
            {content}
            <ChevronDown size={15} className={cn("shrink-0 transition-transform", expanded && "rotate-180")} />
          </button>
        ) : <div className={className}>{content}</div>}
        {expanded && sent && (
          <div className="border-t border-[#7d3548]/50 px-3 pb-2 pt-1">
            {peers.map((peer) => (
              <div key={peer.id} className="flex items-center gap-2 py-1.5 text-[12px] text-ink-secondary">
                <MausAvatar color={peer.color} avatarUrl={peer.avatarUrl} shape={peer.mascotShape} state={stateForBot(peer)} size={18} animated={false} />
                <span className="min-w-0 flex-1 truncate text-ink">{botDisplayName(peer, polish ? "pl" : "en")}</span>
                <span>{statusLabel}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Clickable centered legacy room pill opening the read-only collaboration
 * room where those bots worked on a task together. */
function RoomChip({ message }: { message: Message }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const room = message.room;
  if (!room) return null;
  const pill = "flex max-w-full items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink";
  // A group turn mirrors ONE room shared by every member, so "X texted Y, Z"
  // read as nonsense in a member's private thread: name the group instead and
  // lead back to the group chat, not the room ledger.
  const groupId = room.groupId;
  if (groupId) {
    return (
      <div className="flex justify-center">
        <button
          onClick={() => {
            void authFetch(`/api/groups/${encodeURIComponent(groupId)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((group) => group && dispatch({ type: "toggleGroup", group }));
          }}
          className={pill}
          title={polish ? "Otwórz czat grupowy" : "Open group chat"}
        >
          <span>{polish ? "Rozmowa w grupie" : "Group chat:"}</span>
          <span className="truncate font-medium text-ink">{room.name}</span>
        </button>
      </div>
    );
  }
  const owner = state.bots.find((b) => b.id === room.ownerBotId);
  const peers = room.bot_ids
    .filter((id) => id !== room.ownerBotId)
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  return (
    <div className="flex justify-center">
      <button
        onClick={() => {
          void authFetch(`/api/rooms/${encodeURIComponent(room.id)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((full) => full && dispatch({ type: "toggleRoom", room: full }));
        }}
        className={pill}
        title={polish ? "Otwórz pokój współpracy (tylko do odczytu)" : "Open collaboration room (read-only)"}
      >
        <span className="flex items-center gap-1 font-medium text-ink">
          {owner && (
            <MausAvatar color={owner.color} avatarUrl={owner.avatarUrl} shape={owner.mascotShape} state={stateForBot(owner)} size={18} animated={false} />
          )}
          {owner ? botDisplayName(owner, polish ? "pl" : "en") : room.ownerBotId}
        </span>
        <span>
          {room.event === "replied" ? (polish ? "odpisał(a)" : "replied") : (polish ? "napisał(a) do" : "texted")}
        </span>
        {peers.map((peer) => (
          <span key={peer.id} className="flex items-center gap-1 font-medium text-ink">
            <MausAvatar color={peer.color} avatarUrl={peer.avatarUrl} shape={peer.mascotShape} state={stateForBot(peer)} size={18} animated={false} />
            {botDisplayName(peer, polish ? "pl" : "en")}
          </span>
        ))}
      </button>
    </div>
  );
}

// multibot: część wiadomości użytkownika to nie treść, tylko zdarzenie —
// start rutyny z przelotki (`[Routine: nazwa]`) i sam wybór z pickera `/`.
// Obie pokazujemy jako pigułkę zamiast surowego tekstu; start rutyny jest
// niebieski, żeby wiązał się z listą rutyn.
function userEventChip(message: Message, onOpenRoutines: () => void) {
  if (message.role !== "user" || message.kind !== "text" || message.attachments?.length) return null;
  const routine = routineStartName(message.text);
  if (routine) return <EventChip key={message.id} icon={<CalendarClock size={13} />} value={routine} accent onClick={onOpenRoutines} title="Otwórz rutyny / Open routines" />;
  const command = slashCommandLabel(message.text);
  if (command) return <EventChip key={message.id} icon={<Wand2 size={13} />} value={command} />;
  return null;
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="max-w-[70%] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      {/* multibot: ten sam rozmiar co Bubble — inaczej tekst „skakałby" po
          zakończeniu strumienia */}
      <div className="min-w-0 max-w-[90%] break-words rounded-2xl bg-card px-2 py-[5px] text-[14px] leading-[1.45] text-ink">
        <ChatMarkdown text={text} streaming compact />
        <span className="ml-0.5 inline-block h-[13px] w-[2px] animate-pulse bg-ink-secondary align-middle" />
      </div>
    </div>
  );
}

/** multibot: niebieski separator "NEW" nad pierwszą nieprzeczytaną wiadomością */
function NewSeparator() {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="h-px flex-1 bg-accent/30" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">
        NEW
      </span>
      <div className="h-px flex-1 bg-accent/30" />
    </div>
  );
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const scrollRef = useRef<HTMLDivElement>(null);

  const streaming = state.streaming[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  // multibot: awatar w naglowku czatu trzyma sie tej samej zasady co pasek
  // boczny i wiersz grupy — stoi nieruchomo ZAWSZE, takze gdy bot pracuje.
  // Jedyny animowany bot w aplikacji siedzi na pasku nad composerem.
  const headerAvatar = sidebarAvatarProps(bot);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const touchY = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  // multibot: find-in-chat — Ctrl/Cmd+F otwiera pasek, skok podświetla dymek
  const [findOpen, setFindOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const jumpToHit = useCallback((id: string) => {
    setFollow(false);
    setHighlightId(id);
  }, []);
  useEffect(() => {
    if (!highlightId) return;
    document
      .querySelector(`[data-mb-msg="${CSS.escape(highlightId)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlightId]);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setHighlightId(null);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFollow(false);
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const latestSkillEvent = [...bot.messages].reverse().find((message) => message.event?.type === "skill-created")?.id;
  const lastMessage = bot.messages[bot.messages.length - 1];

  useEffect(() => setFollow(true), [bot.id]);
  useEffect(() => {
    // Własna wiadomość zawsze wraca do live view; przychodzące odpowiedzi nie
    // wyrywają użytkownika z historii, jeśli czyta starsze wiadomości.
    if (lastMessage?.role === "user") setFollow(true);
  }, [lastMessage?.id, lastMessage?.role]);
  useEffect(() => {
    // zmiana bota zamyka find — trafienia należą do starego transkryptu
    setFindOpen(false);
    setHighlightId(null);
  }, [bot.id]);
  useEffect(() => {
    let active = true;
    authFetch(`/api/bots/${bot.id}/skills`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((skills: Array<{ name?: unknown; description?: unknown }>) => {
        if (active) dispatch({
          type: "setSkills",
          skills: skills.flatMap((skill) =>
            typeof skill.name === "string"
              ? [{ name: skill.name, description: typeof skill.description === "string" ? skill.description : undefined }]
              : [],
          ),
        });
      })
      .catch(() => active && dispatch({ type: "setSkills", skills: [] }));
    return () => { active = false; };
  }, [bot.id, latestSkillEvent, dispatch]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bot.id, bot.messages.length, streaming, bot.busy, follow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const jumpToLatest = () => {
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  let previousVisibleAt: number | undefined;

  return (
    <main
      className="relative flex h-full min-w-0 flex-1 flex-col bg-app"
      onDragEnter={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) {
          dragCounter.current++;
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) {
          window.dispatchEvent(new CustomEvent("mb:composer:addFiles", { detail: files }));
        }
      }}
    >
      {/* Header — avatar always visible; special animation when bot is working.
          multibot: data-shell-header = ten rząd zastępuje pasek tytułu okna
          bez ramki (przeciąganie + rezerwa pod kontrolkami, src/styles.css) */}
      <div data-shell-header className="flex items-center justify-between px-5 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-raised/50"
          title={polish ? "Ustawienia bota" : "Bot settings"}
        >
          <span className="relative inline-flex shrink-0 rounded-full">
            <MausAvatar
              color={bot.color} avatarUrl={bot.avatarUrl}
              shape={bot.mascotShape}
              size={40}
              state={headerAvatar.state}
              motion={headerAvatar.motion}
              motionKey={headerAvatar.motionKey}
              animated={headerAvatar.animated}
            />
          </span>
          <span className="text-[15px] font-semibold text-ink">{botDisplayName(bot, polish ? "pl" : "en")}</span>
        </button>
        <div className="flex items-center gap-2">
          <ModelPicker bot={bot} compact />
          {/* multibot: na pulpicie pięć akcji bota chowa się pod „⋮" na końcu
              rzędu, czyli tuż na lewo od kontrolek okna — układ przeniesiony
              z aplikacji mobilnej. W przeglądarce i na serwerze telefonu
              zostają ikony, bo tam nagłówka nic nie ściska. */}
          {isElectron ? (
            <ChatHeaderMenu
              onToggleFind={() => {
                setFollow(false);
                setFindOpen((open) => !open);
              }}
            />
          ) : (
            <>
              <button
                onClick={() => {
                  setFollow(false);
                  setFindOpen((open) => !open);
                }}
                className={cn(
                  "rounded-md p-1.5 hover:bg-raised",
                  findOpen ? "text-accent" : "text-ink hover:text-ink",
                )}
                title={polish ? "Szukaj w rozmowie (Ctrl+F)" : "Find in chat (Ctrl+F)"}
                aria-label={polish ? "Szukaj w rozmowie" : "Find in chat"}
              >
                <Search size={18} />
              </button>
              <button
                onClick={() => dispatch({ type: "toggleInspector" })}
                className={cn("rounded-md p-1.5 hover:bg-raised", state.inspectorOpen ? "text-accent" : "text-ink hover:text-ink")}
                title={polish ? "Inspector runtime" : "Runtime inspector"}
                aria-label={polish ? "Inspector runtime" : "Runtime inspector"}
              >
                <ScanSearch size={18} />
              </button>
              <button
                onClick={() => dispatch({ type: "toggleComputer" })}
                className={cn(
                  "rounded-md p-1.5 hover:bg-raised",
                  state.computerOpen ? "text-accent" : "text-ink hover:text-ink",
                )}
                title={polish ? "Komputer bota" : "Bot's computer"}
              >
                <Monitor size={18} />
              </button>
              <button
                onClick={() => dispatch({ type: "toggleRoutines" })}
                className={cn(
                  "rounded-md p-1.5 hover:bg-raised",
                  state.routinesOpen ? "text-accent" : "text-ink hover:text-ink",
                )}
                title={polish ? "Rutyny bota" : "Bot routines"}
                aria-label={polish ? "Rutyny bota" : "Bot routines"}
              >
                <CalendarClock size={18} />
              </button>
              <button
                onClick={() => dispatch({ type: "toggleSkills" })}
                className={cn(
                  "rounded-md p-1.5 hover:bg-raised",
                  state.skillsOpen ? "text-accent" : "text-ink hover:text-ink",
                )}
                title={polish ? "Umiejętności bota" : "Bot skills"}
                aria-label={polish ? "Umiejętności bota" : "Bot skills"}
              >
                <Wand2 size={18} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error banner */}
      {state.error && (
        <div className="w-full px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* multibot: nakładka przeciągania siedzi w tej samej ramce co lista
          wiadomości, nie w całej kolumnie czatu — inaczej jej środek wypadał
          między nagłówkiem a polem pisania i karta wyglądała na przesuniętą. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {findOpen && (
          <ChatFindBar messages={bot.messages} onClose={closeFind} onJump={jumpToHit} />
        )}
        {/* Messages */}
        <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        {/* multibot: `pb-16` (64 px) zamiast `pb-10` — przy dojechaniu na sam
            dół ostatnia wiadomość kleiła się do pola pisania. Composer stoi
            w tym samym wierszu flexa, nie na nakładce, więc te 24 px ponad
            dotychczasowe 40 to czysty oddech pod ostatnim dymkiem. */}
        <div className="flex w-full min-w-0 flex-col gap-1 pb-16">
          {bot.messages.map((m, messageIndex) => {
            let child: ReactNode;
            switch (m.kind) {
              case "secret":
                child = <SecretRequestCard key={m.id} botId={bot.id} message={m} />;
                break;
              case "options":
                // multibot: karta przekazania komputera ma własny render
                // (miniatura ekranu + przejmij/gotowe/pomiń), reszta kart bez zmian
                child = m.card?.kind === "computer-handoff"
                  ? <ComputerHandoffCard key={m.id} botId={bot.id} message={m} />
                  : m.card?.kind === "connect"
                    ? <ConnectCard key={m.id} botId={bot.id} message={m} polish={polish} />
                    : <OptionCard key={m.id} botId={bot.id} message={m} />;
                break;
              // multibot: wywołania narzędzi lecą dalej do stanu (Sidebar pokazuje
              // last.tool.name jako status), ale w czacie są niewidoczne —
              // decyzja Kacpra 21.08: żadnych chipów narzędzi w transkrypcie.
              case "activity":
                child = null;
                break;
              case "event":
                child = <EventPill key={m.id} message={m} polish={polish} />;
                break;
              case "room":
                {
                  const activityGroup = peerActivityGroupFor(bot.messages, messageIndex, bot.id);
                  child = activityGroup
                    ? activityGroup[0]?.id === m.id
                      ? <PeerActivity key={m.id} messages={activityGroup as Message[]} currentBotId={bot.id} />
                      : null
                    : <RoomChip key={m.id} message={m} />;
                }
                break;
              case "screen":
                child = m.png ? <ScreenFrame key={m.id} png={m.png} mime={m.mime} /> : null;
                break;
              default:
                // multibot: pigułka zdarzenia wygrywa z dymkiem, gdy treść
                // wiadomości jest samym zdarzeniem (patrz userEventChip)
                child = userEventChip(m, () => dispatch({ type: "toggleRoutines", open: true })) ?? (
                  <Bubble
                    key={m.id}
                    botId={bot.id}
                    message={m}
                    highlighted={highlightId === m.id}
                    replyTarget={replyTargetOf(bot.messages, m.replyToId)}
                    replyBotName={botDisplayName(bot, polish ? "pl" : "en")}
                    onJumpTo={jumpToHit}
                  />
                );
            }
            const visible = child != null;
            const sessionStart = visible && shouldStartChatSession(previousVisibleAt, m.at);
            if (visible) previousVisibleAt = m.at;
            return (
              <Fragment key={m.id}>
                {sessionStart && <SessionSeparator at={m.at} polish={polish} />}
                {bot.firstUnreadId === m.id && <NewSeparator />}
                {/* SKILL.md stays outside and above its message, on sender side. */}
                {!!m.attachments?.some((f) => f.name.toLowerCase() === "skill.md") && (
                  <div className={cn("flex w-full", m.role === "user" ? "justify-end" : "justify-start")}>
                    <div className="mb-2 flex w-full min-w-0 max-w-[70%] flex-col gap-2">
                      {m.attachments
                        .filter((f) => f.name.toLowerCase() === "skill.md")
                        .map((f) => (
                          <MessageAttachment key={f.id} botId={bot.id} file={f} />
                        ))}
                    </div>
                  </div>
                )}
                {child}
              </Fragment>
            );
          })}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                {polish ? "Konfigurowanie komputera bota…" : "Setting up this bot's computer…"}
              </div>
            </div>
          )}
          {streaming ? <StreamingBubble text={streaming} /> : null}
        </div>
        </div>
        {/* desktop drag&drop overlay — any file dropped onto chat becomes an attachment */}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-app/70 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent/60 bg-card px-10 py-8 text-center shadow-2xl">
              <span className="flex size-12 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Upload size={24} />
              </span>
              <div className="flex flex-col gap-1">
                <span className="text-[15px] font-semibold text-ink">
                  {polish ? "Upuść pliki tutaj" : "Drop files here"}
                </span>
                <span className="flex items-center justify-center gap-1.5 text-[12px] text-ink-secondary">
                  <FileIcon size={12} /> {polish ? "Zostaną dodane jako załączniki" : "They'll be added as attachments"}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Reading scrollback while new content arrives — one tap back to live */}
      {!follow && (bot.busy || Boolean(streaming)) && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> {polish ? "Przejdź do najnowszych" : "Jump to latest"}
        </button>
      )}

      <Composer bot={bot} />

    </main>
  );
}
