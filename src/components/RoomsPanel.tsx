// Every bot-to-bot conversation in one list. A room IS the conversation: one
// bot writes to another (or to two at once), they all work in the same
// transcript, in no fixed order. There is no separate mailbox to reconcile —
// clicking a row opens that room's live transcript in RoomPanel.
import { useMemo } from "react";
import { ArrowLeft, Loader2, MessagesSquare, X } from "lucide-react";

import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/cn";
import { formatTime, useStore, type Room } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { botDisplayName } from "@/lib/botNames";

/** Running rooms first, then the settled ones, newest first inside each group. */
export function sortRooms(rooms: Room[]): Room[] {
  const rank = (room: Room) => (room.status === "running" ? 0 : 1);
  return rooms.slice().sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

export function RoomsPanel() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const rooms = useMemo(() => sortRooms(state.rooms), [state.rooms]);
  const close = () => dispatch({ type: "toggleRooms", open: false });

  const statusLabel = (room: Room) =>
    room.status === "running"
      ? polish ? "pracują…" : "working…"
      : room.status === "done"
        ? polish ? "zakończone" : "done"
        : polish ? "przerwane" : "failed";

  return (
    <main className="animate-panel-in flex h-full min-w-0 flex-1 flex-col bg-app text-ink">
      <header className="flex items-center gap-3 border-b border-hairline/40 px-4 py-3">
        <button
          onClick={close}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label={polish ? "Wróć do czatu" : "Back to chat"}
        >
          <ArrowLeft size={18} />
        </button>
        <MessagesSquare size={18} className="text-accent" />
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold">{polish ? "Rozmowy botów" : "Bot rooms"}</h1>
          <p className="text-[11px] text-ink-secondary">
            {polish
              ? "Tymczasowe pokoje, w których boty rozwiązują zadanie razem"
              : "Temporary rooms where bots solve a task together"}
          </p>
        </div>
        <button onClick={close} className="ml-auto rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={polish ? "Zamknij" : "Close"}>
          <X size={18} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rooms.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-ink-secondary">
            <MessagesSquare size={26} />
            <span className="text-[13px]">{polish ? "Boty jeszcze ze sobą nie rozmawiały" : "The bots have not talked to each other yet"}</span>
          </div>
        ) : (
          rooms.map((room) => {
            const members = room.bot_ids
              .map((id) => state.bots.find((bot) => bot.id === id))
              .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot));
            const owner = state.bots.find((bot) => bot.id === room.ownerBotId);
            return (
              <button
                key={room.id}
                onClick={() => dispatch({ type: "toggleRoom", room })}
                className="mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised/70"
              >
                <span className="flex shrink-0 items-center -space-x-2">
                  {members.slice(0, 4).map((bot) => (
                    <MausAvatar
                      key={bot.id}
                      color={bot.color}
                      avatarUrl={bot.avatarUrl}
                      shape={bot.mascotShape}
                      state={stateForBot(bot)}
                      size={26}
                      animated={false}
                    />
                  ))}
                  {members.length > 4 && (
                    <span className="pl-3 text-[11px] text-ink-secondary">+{members.length - 4}</span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{room.task || room.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-ink-secondary">
                    {members.map((bot) => botDisplayName(bot, polish ? "pl" : "en")).join(" · ")}
                    {owner && ` · ${polish ? "zaczął" : "opened by"} ${botDisplayName(owner, polish ? "pl" : "en")}`}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span
                    className={cn(
                      "flex items-center justify-end gap-1 text-[11px]",
                      room.status === "running" ? "text-accent" : "text-ink-secondary",
                    )}
                  >
                    {room.status === "running" && <Loader2 size={11} className="animate-spin" />}
                    {statusLabel(room)}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-ink-secondary">
                    {room.transcript.length} {polish ? "wiad." : "msgs"}
                  </span>
                  <span className="block text-[10px] text-ink-secondary">{formatTime(room.createdAt)}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </main>
  );
}
