// Read-only view of a durable bot-to-bot collaboration room. Opened by
// clicking the "X texted Y" chip in a conversation; the user watches the bots
// work on the task together but cannot post. Live updates ride the SSE "room"
// frames into store.roomOpen.
import { useEffect, useRef, useState } from "react";
import { Eye, Loader2, Users, X } from "lucide-react";
import { useStore, formatTime, type Room } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { formatPeerEnvelope } from "@/lib/peerEnvelope";
import { BotAvatar } from "./Avatar";
import { staticAvatarProps } from "@/lib/mascot";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

export function RoomPanel() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const room = state.roomOpen;
  const [gone, setGone] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const touchY = useRef(0);

  // Refresh the transcript once on mount in case the chip's snapshot is stale.
  useEffect(() => {
    if (!room) return;
    let alive = true;
    api(`/api/rooms/${encodeURIComponent(room.id)}`)
      .then((full: Room) => alive && dispatch({ type: "toggleRoom", room: full }))
      .catch(() => alive && setGone(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  useEffect(() => setFollow(true), [room?.id]);
  useEffect(() => {
    if (follow) transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [room?.id, room?.transcript.length, room?.status, follow]);

  const atEnd = () => {
    const el = transcriptRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (!room) return null;
  const members = room.bot_ids
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  const nameOf = (botId: string) => {
    const found = state.bots.find((b) => b.id === botId);
    return found ? botDisplayName(found, polish ? "pl" : "en") : polish ? "usunięty bot" : "deleted bot";
  };
  // multibot: klikalna pigułka nazwy — otwiera czat tego bota, jak na screenie
  // "Klaus Chief" / "Klaus -> Motion". Zamyka pokój i selectuje bota.
  const openBot = (botId: string) => {
    if (!state.bots.some((b) => b.id === botId)) return;
    dispatch({ type: "toggleRoom", room: null });
    dispatch({ type: "select", id: botId });
  };
  const statusLabel =
    room.status === "running"
      ? polish ? "pracują…" : "working…"
      : room.status === "done"
        ? polish ? "zakończone" : "done"
        : polish ? "przerwane" : "failed";

  return (
    <main className="animate-panel-in flex h-full min-w-0 flex-1 flex-col bg-app">
      <div data-shell-header className="flex items-center px-5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {members.length > 0 ? (
            // Any number of bots: stacked avatars plus the names as one list.
            // The old header hard-coded a pair ("[avatar] A ⇄ [avatar] B") and
            // hid everyone past the second, which a three-bot room needs.
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex shrink-0 items-center -space-x-2">
                {members.slice(0, 5).map((bot) => (
                  <span key={bot.id} className="relative inline-flex shrink-0 rounded-full bg-app ring-2 ring-app">
                    <BotAvatar color={bot.color} avatarUrl={bot.avatarUrl} shape="blob" size={24} {...staticAvatarProps(bot)} />
                  </span>
                ))}
              </span>
              <span className="truncate text-[15px] font-semibold text-ink">
                {members.map((bot) => botDisplayName(bot, polish ? "pl" : "en")).join(" · ")}
              </span>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
                <Users size={16} />
              </span>
              <div className="truncate text-[15px] font-semibold text-ink">
                {room.name || (polish ? "Pokój współpracy" : "Collaboration")}
              </div>
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-[11px] text-ink-secondary">
              {members.length > 0 && `${room.bot_ids.map(nameOf).join(" · ")} · `}{statusLabel}
            </div>
          </div>
        </div>
        <button
          onClick={() => dispatch({ type: "toggleRoom", room: null })}
          className="ml-auto rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label={polish ? "Zamknij pokój" : "Close room"}
        >
          <X size={18} />
        </button>
      </div>

      <div
        ref={transcriptRef}
        className="flex-1 overflow-y-auto px-5 pb-3 [overflow-anchor:none]"
        onWheel={(event) => {
          if (event.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onTouchStart={(event) => (touchY.current = event.touches[0]?.clientY ?? 0)}
        onTouchMove={(event) => {
          const y = event.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        {gone ? (
          <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
            <Users size={22} />
            <div className="text-[13px] font-medium text-ink">{polish ? "Pokój już nie istnieje" : "This room no longer exists"}</div>
            <span className="text-[12px]">
              {polish ? "Transkrypt tego pokoju nie jest dostępny." : "This room transcript is unavailable."}
            </span>
          </div>
        ) : room.transcript.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
            <Users size={22} />
            <div className="text-[13px] font-medium text-ink">{polish ? "Boty zaczynają…" : "The bots are starting…"}</div>
            {room.status === "running" && <Loader2 size={14} className="animate-spin" />}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {room.transcript.map((entry) => {
              const entryBot = members.find((b) => b.id === entry.from);
              return (
                <div key={entry.id} className="flex justify-start gap-2.5">
                  <div className="min-w-0 max-w-[85%]">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => openBot(entry.from)}
                        className="flex shrink-0 items-center gap-1.5 rounded-full bg-raised/60 py-0.5 pl-0.5 pr-2 hover:bg-raised"
                        title={polish ? `Otwórz czat ${nameOf(entry.from)}` : `Open ${nameOf(entry.from)}'s chat`}
                      >
                        {entryBot && (
                          <span className="relative inline-flex shrink-0 rounded-full bg-app ring-2 ring-app">
                            <BotAvatar color={entryBot.color} avatarUrl={entryBot.avatarUrl} shape="blob" size={28} {...staticAvatarProps(entryBot)} />
                          </span>
                        )}
                        <span className="text-[12.5px] font-semibold text-accent">{nameOf(entry.from)}</span>
                      </button>
                      <span className="text-[11px] text-ink-secondary">{formatTime(entry.at)}</span>
                    </div>
                    {/* multibot: ta sama wypowiedź bota ma wyglądać tak samo
                        w czacie 1:1, w grupie i tutaj. Widok pokoju został
                        przy rozmiarach panelu (`px-3.5 py-2 leading-relaxed`,
                        markdown bez `compact`), więc pigułki wzmianek, tabele
                        i bloki kodu były w nim większe niż te same pigułki
                        w czacie. Wartości i flaga jak w ChatView/GroupPanel. */}
                    <div className="rounded-2xl bg-card px-2 py-[5px] text-[14px] leading-[1.45] text-ink">
                      <ChatMarkdown text={formatPeerEnvelope(entry.text)} compact />
                    </div>
                  </div>
                </div>
              );
            })}
            {room.status === "running" ? (
              <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <Loader2 size={12} className="animate-spin" />
                {polish ? "Boty pracują…" : "The bots are working…"}
              </div>
            ) : (
              <div className="rounded-xl border border-hairline/40 bg-card/60 px-3.5 py-2.5 text-[12.5px] text-ink-secondary">
                <div className="mb-0.5 font-semibold text-ink">{polish ? "Raport dla właściciela" : "Owner report"}</div>
                {polish
                  ? `Rozmowa ${statusLabel}. Podsumowanie trafiło do czatu ${nameOf(room.ownerBotId)}.`
                  : `This room is ${statusLabel}. The summary went to ${nameOf(room.ownerBotId)}'s chat.`}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Read-only: no composer — the user watches the bots work. */}
      <div className="border-t border-hairline/40 px-4 py-3">
        <div className="flex items-center justify-center gap-2 text-[12px] text-ink-secondary">
          <Eye size={14} />
          {polish ? "Ten czat jest tylko do wyświetlania" : "This chat is read-only"}
          <button
            onClick={() => dispatch({ type: "toggleRoom", room: null })}
            className="rounded-full bg-raised px-3 py-1 text-[12px] text-ink hover:bg-raised-hover"
          >
            {polish ? "Zamknij czat" : "Close chat"}
          </button>
        </div>
      </div>
    </main>
  );
}
