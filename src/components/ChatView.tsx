import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ArrowDown, Bell, CalendarClock, Crosshair, File as FileIcon, Loader2, Monitor, Search, Upload, Wand2 } from "lucide-react";
// multibot: wspólna pigułka zdarzenia i wspólna karta pliku
import { Spinner } from "./Loading";
import { EventChip } from "./EventChip";
import { SkillRef } from "./SkillRef";
import { AttachmentCard } from "./AttachmentCard";
// multibot: lightbox załączników-obrazków (port z upstreamu #436)
import { AttachmentPreviewDialog } from "./AttachmentPreview";
// multibot: pasek szukania w transkrypcie (port z upstreamu #437)
import { ChatFindBar } from "./ChatFindBar";
import { useChatFind } from "@/lib/useChatFind";
// multibot: flat replies — cytowanie wiadomości (port z upstreamu #437)
import { ReplyQuote, replyTargetOf } from "./ReplyQuote";
import { routineStartName, slashCommandLabel } from "@/lib/transcriptChips";
import { useStore, type Bot, type Message } from "@/state/store";
import { formatPeerEnvelope, parsePeerEnvelope } from "@/lib/peerEnvelope";
import { PeerBadge } from "./PeerBadge";
import { formatChatSessionTime, shouldStartChatSession } from "@/lib/chatSessions";
import { BotAvatar } from "./Avatar";
import { BOT_COLORS, staticAvatarProps } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { CopyMessageButton } from "./CopyMessageButton";
import { OptionCard } from "./OptionCard";
import { ComputerHandoffCard } from "./ComputerHandoffCard";
import { ConnectCard } from "./ConnectCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { Composer, setBotDraft } from "./Composer";
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
// multibot (K5): pobranie/podgląd pliku przez powłokę telefonu
import { openFileViaShell } from "@/lib/nativeBridge";
import { peerActivityGroupFor } from "@/lib/peerActivity";
// multibot: wygasłe logowanie harnessu — banerka z przyciskiem naprawy
import { AuthExpiredBanner, LoginExpiredCard } from "./AuthExpiredBanner";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

function MessageAttachment({ botId, file }: { botId: string; file: NonNullable<Message["attachments"]>[number] }) {
  const [url, setUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Ta sama ścieżka, z której bierzemy bloba. W powłoce telefonu idzie do
  // mostu natywnego, bo tam ani `<a download>`, ani `window.open` na blobie
  // nic nie robią (K5).
  const path = `/api/bots/${botId}/attachments/${file.id}`;
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
          <AttachmentPreviewDialog url={url} name={file.name} path={path} mime={file.mime} onClose={() => setPreviewOpen(false)} />
        )}
      </>
    ) : <div className="h-24 w-40 animate-pulse rounded-xl bg-raised" />;
  }
  return (
    <div className="flex items-center gap-2">
      {/* multibot: karta pliku wspólna dla załączników użytkownika i bota */}
      <div className="min-w-0 flex-1">
        <AttachmentCard name={file.name} size={file.size} url={url} path={path} mime={file.mime} />
      </div>
      {file.mime === "text/html" && (
        <button
          type="button"
          disabled={!url}
          onClick={() => {
            if (openFileViaShell(path, file.name, file.mime)) return;
            if (url) window.open(url, "_blank", "noopener,noreferrer");
          }}
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
      // multibot: seria dymków (iMessage) — reguły w styles.css, sekcja
      // `[data-mb-side]`. O przynależności do serii decyduje SĄSIEDZTWO W DOM,
      // nie indeks wiadomości: między dymkami stają pigułki zdarzeń, chipy
      // pokoju, karty, podglądy ekranu, załącznik SKILL.md i separatory sesji
      // — każde z nich przerywa serię i przerywa ją samym tym, że stoi
      // pomiędzy. Dlatego nie ma tu mapy „ta wiadomość jest N-ta w serii":
      // musiałaby powtórzyć całą logikę widoczności z pętli renderującej.
      data-mb-side={user ? "user" : "bot"}
      className={cn(
        "group/msg flex w-full rounded-2xl transition-shadow",
        user ? "justify-end" : "justify-start",
        highlighted ? "ring-2 ring-accent/70" : "",
      )}
    >
      {/* multibot: wiersz dymek+przyciski — rząd (TTS, kopiuj) stoi na PRAWO
          od dymka, na tle czatu, wyrównany do jego dołu; pod dymkiem nie ma
          już stopki, więc dymki bota niemal się stykają (gap-1 listy). Hover
          dalej steruje `group/msg` na całym wierszu, więc przejazd myszą
          dymek→przycisk niczego nie chowa. Sufit 90% liczy się dla całości
          (dymek + przyciski), przyciski są `shrink-0`. */}
      <div className="flex min-w-0 max-w-[90%] items-end gap-1">
      <div
        data-mb-bubble=""
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
          // multibot: `min-w-0 max-w-[90%]` przeniesione na wrapper wiersza wyżej
          "min-w-0 break-words rounded-2xl px-2 py-[5px] text-[14px] leading-[1.45]",
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
              // multibot: kotwica dla find-in-chat — walker po trafieniach
              // schodzi tu i w `.chat-md`, czyli w treść dymka wraz z plakietką
              // nadawcy, ale już nie w stopkę, badge modelu ani cytat
              data-mb-body=""
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
      </div>
      {/* multibot: przyciski obok dymka; czas sesji renderuje się osobno
          między wiadomościami. U użytkownika rząd byłby pusty, więc nie
          renderujemy go wcale. */}
      {!user && (
        <div className="flex shrink-0 items-center gap-1.5 text-[10px] leading-none">
          {/* multibot: TTS — see SpeakButton.tsx; renders null with no voice key */}
          <SpeakButton text={text} />
          {/* multibot: kopiowanie zrodla wiadomosci - patrz CopyMessageButton.tsx */}
          <CopyMessageButton text={text} />
        </div>
      )}
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
  // Rutyna prowadzi w panel rutyn; przypomnienie — ustawione i odpalone — w
  // panel przypomnień (od 10.09.2026 to osobny rekord, nie rutyna z datą).
  const routineEvent = message.event.type === "routine-created";
  const reminderEvent = message.event.type === "reminder-created" || message.event.type === "reminder";
  const labels = polish
    ? { renamed: "Zmieniono nazwę na", "skill-created": "Utworzono umiejętność", "routine-created": "Utworzono rutynę", "reminder-created": "Przypomnienie", reminder: "Przypomnienie", "goal-progress": "Cel" }
    : { renamed: "Renamed to", "skill-created": "Created skill", "routine-created": "Created routine", "reminder-created": "Reminder", reminder: "Reminder", "goal-progress": "Goal" };
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
        routineEvent ? <CalendarClock size={13} />
          : reminderEvent ? <Bell size={13} />
            : message.event.type === "goal-progress" ? <Crosshair size={13} /> : undefined
      }
      label={labels[message.event.type]}
      value={message.event.value}
      onClick={
        routineEvent
          ? () => dispatch({ type: "toggleRoutines", open: true })
          : reminderEvent
            ? () => dispatch({ type: "toggleRoutines", open: true, tab: "reminders" })
            : undefined
      }
      title={
        routineEvent
          ? "Otwórz rutyny / Open routines"
          : reminderEvent
            ? "Otwórz przypomnienia / Open reminders"
            : undefined
      }
    />
  );
}

/** Pulls the full transcript and swaps the chat for the read-only room view. */
function openRoom(roomId: string, dispatch: ReturnType<typeof useStore>["dispatch"]) {
  return authFetch(`/api/rooms/${encodeURIComponent(roomId)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((full) => full && dispatch({ type: "toggleRoom", room: full }));
}

/** A bot-to-bot card is a door, not a drawer: tapping it swaps the chat for the
 * room's read-only transcript (see RoomPanel). Between 07.09 and this fix the
 * card only expanded downwards into a member list and the room was unreachable.
 * The peer's chip inside the sentence is a second door: it opens that bot's own
 * chat instead of the room. */
function PeerActivity({ messages, currentBotId }: { messages: Message[]; currentBotId: string }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [opening, setOpening] = useState(false);
  const first = messages[0];
  const room = first?.room;
  if (!room?.event) return null;
  const sent = room.event === "texted" && room.ownerBotId === currentBotId;
  const actor = state.bots.find((bot) => bot.id === room.ownerBotId);
  const peerIds = [...new Set(messages.flatMap((message) => message.room?.bot_ids ?? []).filter((id) => id !== room.ownerBotId && id !== currentBotId))];
  const peers = peerIds.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
  const chip = (bot: Bot | undefined, fallback: string) => {
    if (!bot) return <span className="truncate">{fallback}</span>;
    const name = botDisplayName(bot, polish ? "pl" : "en");
    // multibot: nigdy nie pokazujemy awatara bota, którego czat jest właśnie
    // otwarty; bot ukryty nie ma wiersza w pasku, więc też nie jest linkiem.
    if (bot.id === currentBotId || bot.hidden) return <span className="truncate">{name}</span>;
    const activate = (event: MouseEvent | ReactKeyboardEvent) => {
      if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "select", id: bot.id });
    };
    return (
      <span
        role="link"
        tabIndex={0}
        title={polish ? "Otwórz czat z tym botem" : "Open this bot's chat"}
        onClick={activate}
        onKeyDown={activate}
        // multibot: `bot.color` to NAZWA z allowlisty, nie kolor CSS — bez
        // BOT_COLORS obwódka brałaby słowo kluczowe CSS (`green` = #008000).
        // `--bot-ink` to kolor bota dociągnięty w połowie do atramentu skórki: sam
        // hex tonie i na jasnych skórkach (yellow, white), i na ciemnych (black).
        // 50/50 w oklab trzyma odcień, a najgorszy kontrast na wypełnieniu to
        // 3,3:1 (lagoon/white) dla całej allowlisty w czterech skórkach.
        style={{
          "--bot": BOT_COLORS[bot.color] ?? BOT_COLORS.green,
          "--bot-ink": "color-mix(in oklab, var(--bot) 50%, var(--color-ink))",
        } as CSSProperties}
        className="inline-flex items-center gap-1 rounded-full min-w-0 px-1.5 py-0.5 text-[var(--bot-ink)] [box-shadow:0_0_0_1px_var(--bot-ink)] bg-[color-mix(in_oklab,var(--bot)_18%,var(--color-app))] hover:bg-[color-mix(in_oklab,var(--bot)_32%,var(--color-app))] focus-visible:bg-[color-mix(in_oklab,var(--bot)_32%,var(--color-app))] focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus focus-visible:outline-offset-1 transition-[background-color] duration-150"
      >
        <BotAvatar color={bot.color} avatarUrl={bot.avatarUrl} shape="blob" size={20} {...staticAvatarProps(bot)} />
        <span className="truncate">{name}</span>
      </span>
    );
  };
  const visiblePeers = peers.slice(0, 3);
  const extraPeers = peers.length - visiblePeers.length;
  // multibot: opis to jeden rząd flexa, nie zdanie z chipami wklejonymi w tekst.
  // Chip jest `inline-flex`, więc w toku tekstu bierze linię bazową z awatara i
  // tekst obok siada 2,2 px niżej (zmierzone) — `items-center` to kasuje.
  // `p-1 -m-1` daje `overflow-hidden` zapas na stałą obwódkę chipa (1 px) i na
  // obwódkę fokusu (1 px + 1 px offsetu) — razem 3 px z 4 px zapasu.
  const content = (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden p-1 -m-1">
      <span className="shrink-0">{sent ? (polish ? "Napisano do" : "Messaged") : (polish ? "Wiadomość od" : "Message from")}</span>
      {sent
        ? visiblePeers.length
          ? visiblePeers.map((bot) => <Fragment key={bot.id}>{chip(bot, bot.id)}</Fragment>)
          : <span className="truncate">{room.bot_ids[1] ?? (polish ? "agenta" : "agent")}</span>
        : chip(actor, room.ownerBotId)}
      {sent && extraPeers > 0 && <span className="shrink-0">{`+${extraPeers}`}</span>}
    </span>
  );
  return (
    <div className="flex w-full justify-center">
      <button
        type="button"
        onClick={() => {
          setOpening(true);
          void openRoom(room.id, dispatch).finally(() => setOpening(false));
        }}
        disabled={opening}
        aria-busy={opening}
        title={polish ? "Otwórz pokój współpracy (tylko do odczytu)" : "Open collaboration room (read-only)"}
        className="flex w-full min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md py-1 text-[13px] text-ink-secondary transition-[color,outline-color,transform] duration-150 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink/25 focus-visible:outline-offset-2 active:scale-[0.97] active:text-ink disabled:cursor-wait disabled:scale-[0.98] disabled:text-ink"
      >
        {content}
        {opening && <Spinner size={13} className="shrink-0" />}
      </button>
    </div>
  );
}

/** Clickable centered legacy room pill opening the read-only collaboration
 * room where those bots worked on a task together. */
function RoomChip({ message }: { message: Message }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [opening, setOpening] = useState(false);
  const room = message.room;
  if (!room) return null;
  const pill = "flex max-w-full items-center gap-1.5 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink";
  const groupPill = "flex max-w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink active:bg-raised-hover focus-visible:bg-raised focus-visible:text-ink focus-visible:outline-none";
  // A group turn mirrors ONE room shared by every member, so "X texted Y, Z"
  // read as nonsense in a member's private thread: name the group instead and
  // lead back to the group chat, not the room ledger.
  const groupId = room.groupId;
  if (groupId) {
    return (
      <div className="flex justify-center">
        <button
          onClick={() => {
            setOpening(true);
            void authFetch(`/api/groups/${encodeURIComponent(groupId)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((group) => group && dispatch({ type: "toggleGroup", group }))
              .finally(() => setOpening(false));
          }}
          className={groupPill}
          title={polish ? "Otwórz czat grupowy" : "Open group chat"}
        >
          {opening && <Spinner size={13} />}
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
          setOpening(true);
          void openRoom(room.id, dispatch).finally(() => setOpening(false));
        }}
        className={pill}
        title={polish ? "Otwórz pokój współpracy (tylko do odczytu)" : "Open collaboration room (read-only)"}
      >
        {opening && <Spinner size={13} />}
        <span className="flex items-center gap-1 font-medium text-ink">
          {owner && (
            <BotAvatar color={owner.color} avatarUrl={owner.avatarUrl} shape="blob" size={18} {...staticAvatarProps(owner)} />
          )}
          {owner ? botDisplayName(owner, polish ? "pl" : "en") : room.ownerBotId}
        </span>
        <span>
          {room.event === "replied" ? (polish ? "odpisał(a)" : "replied") : (polish ? "napisał(a) do" : "texted")}
        </span>
        {peers.map((peer) => (
          <span key={peer.id} className="flex items-center gap-1 font-medium text-ink">
            <BotAvatar color={peer.color} avatarUrl={peer.avatarUrl} shape="blob" size={18} {...staticAvatarProps(peer)} />
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
    // multibot: dymek strumienia dokleja się do serii bota tak samo jak gotowy
    // (patrz styles.css `[data-mb-side]`) — inaczej ostatni dymek odskakiwałby
    // w chwili, gdy strumień się kończy i Bubble go podmienia.
    <div className="flex w-full justify-start" data-mb-side="bot">
      {/* multibot: ten sam rozmiar co Bubble — inaczej tekst „skakałby" po
          zakończeniu strumienia; wrapper-wiersz identyczny jak w Bubble
          (bez przycisków), żeby sufit szerokości liczył się w tym samym
          miejscu. */}
      <div className="flex min-w-0 max-w-[90%] items-end gap-1">
      <div data-mb-bubble="" className="min-w-0 break-words rounded-2xl bg-card px-2 py-[5px] text-[14px] leading-[1.45] text-ink">
        <ChatMarkdown text={text} streaming compact />
        <span className="ml-0.5 inline-block h-[13px] w-[2px] animate-pulse bg-ink-secondary align-middle" />
      </div>
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
  // ChatView stays mounted while sidebar selection changes. Keeping drafts in
  // this map makes the textarea follow the selected bot without overwriting
  // the text that belongs to another conversation.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft = useCallback((text: string) => {
    setDrafts((current) => setBotDraft(current, bot.id, text));
  }, [bot.id]);

  const streaming = state.streaming[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  // multibot (poziom Status): bot TERAZ klika na wspólnym komputerze. Nie to
  // samo co otwarty panel — ikona ma świecić, bo maszyna pracuje, a nie dlatego,
  // że ktoś ją sobie podejrzał. Serwer nadaje to ramką `computer-queue`.
  const computerActing = state.computerActing.includes(bot.id);
  // multibot: awatar w naglowku czatu stoi nieruchomo ZAWSZE, takze gdy bot
  // pracuje — jedynym animowanym sygnalem tury w widoku czatu jest pasek nad
  // composerem (roster ma wlasna regule: `sidebarAvatarProps`).
  const headerAvatar = staticAvatarProps(bot);
  // Jeden przycisk na obie powłoki: w przeglądarce stoi w rzędzie ikon zawsze,
  // na pulpicie (gdzie akcje siedzą pod „⋮") pokazuje się TYLKO wtedy, gdy bot
  // pracuje na komputerze — inaczej status byłby schowany w zwiniętym menu.
  const computerLabel = computerActing
    ? polish ? "Bot pracuje na komputerze" : "The bot is using the computer"
    : polish ? "Komputer bota" : "Bot's computer";
  const computerButton = (
    <button
      onClick={() => dispatch({ type: "toggleComputer" })}
      className={cn(
        "relative rounded-md p-1.5 hover:bg-raised",
        computerActing || state.computerOpen ? "text-accent" : "text-ink hover:text-ink",
      )}
      title={computerLabel}
      // Czytnik ekranu ma słyszeć to samo, co mówi dymek — sam kolor ikony nie
      // niesie dla niego niczego.
      aria-label={computerLabel}
      data-computer-acting={computerActing ? "1" : undefined}
    >
      <Monitor size={18} />
      {computerActing && (
        <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
      )}
    </button>
  );

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
  // multibot: trafienia w treści — podświetla je useChatFind po Range'ach
  // (patrz lib/findInChat.ts), pasek pokazuje tylko „3/17".
  const find = useChatFind(scrollRef, findOpen);
  const resetFind = find.reset;
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setHighlightId(null);
    resetFind();
  }, [resetFind]);
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
    // zmiana bota zamyka find — trafienia należą do starego transkryptu,
    // razem z wpisaną frazą (inaczej pasek wracał z zapytaniem poprzedniego bota)
    setFindOpen(false);
    setHighlightId(null);
    resetFind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            <BotAvatar
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
            <>
              {computerActing && computerButton}
              <ChatHeaderMenu
                onToggleFind={() => {
                  setFollow(false);
                  setFindOpen((open) => !open);
                }}
              />
            </>
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
              {/* hidden per Kacper 07.09.2026, panels kept */}
              {computerButton}
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

      {/* multibot: logowanie CLI wygasło — jedno kliknięcie prowadzi do
          okna logowania tego narzędzia w ustawieniach. */}
      <AuthExpiredBanner bot={bot} />

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
          <ChatFindBar find={find} onClose={closeFind} />
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
          // przy otwartym pasku szukania NIE wracamy do trybu „goń dół": to
          // programowe przewinięcie na trafienie dojechało do końca listy, a
          // nie użytkownik prosił o live view
          if (!follow && !findOpen && atEnd()) setFollow(true);
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
              // multibot: karta „logowanie wygasło" z przyciskiem odświeżenia
              case "login":
                child = <LoginExpiredCard key={m.id} message={m} />;
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

      <Composer bot={bot} draft={drafts[bot.id] ?? ""} onDraftChange={setDraft} />

    </main>
  );
}
