// multibot: grupa to ZWYKŁY czat, tylko z kilkoma botami naraz — ten sam
// układ co `ChatView` (lista wiadomości + `Composer`), te same bańki, ten sam
// pasek maskotki. Nie ma tu zadań per bot ani przycisku uruchamiania: user
// pisze jedno zdanie do wszystkich, a serwer decyduje, kto odpowiada
// (`runGroupChat` w server/index.ts).
//
// ŹRÓDŁO HISTORII: pokój grupy (`room.groupId === group.id`). Serwer dopisuje
// tam wiadomość usera jako `from: "user"` i każdą odpowiedź członka, a ramki
// SSE `room` odświeżają panel w trakcie tury. `group.messages` zostaje jako
// zapas dla grup sprzed tej zmiany, które pokoju jeszcze nie mają.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Loader2, Monitor, Users } from "lucide-react";
import { useStore, formatTime, type Bot, type EngineGroup } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { MausAvatar } from "./Avatar";
import { GROUP_AVATAR_STATE } from "@/lib/mascot";
import { formatPeerEnvelope } from "@/lib/peerEnvelope";
import { Composer } from "./Composer";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";

// Ten sam lokalny helper co RoutinesPanel: silnik zwraca błędy jako `{detail}`
// (FastAPI), przelotka jako `{error}`.
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    throw new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

/** `from`: "user"/"you" (człowiek) albo id bota. */
interface Entry {
  id: string;
  from: string;
  text: string;
  at: number;
}

const isUserEntry = (from: string) => from === "user" || from === "you";

export function GroupPanel({ group }: { group: EngineGroup }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [legacy, setLegacy] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    let alive = true;
    api(`/api/groups/${group.id}`)
      .then((saved: { messages?: Array<{ id?: string; from: string; text: string; at: number }> }) =>
        alive && setLegacy((saved.messages ?? []).map((m, i) => ({ id: m.id ?? `legacy-${i}`, from: m.from, text: m.text, at: m.at }))))
      .catch(() => {});
    return () => { alive = false; };
  }, [group.id]);

  const members: Bot[] = useMemo(
    () => group.bot_ids
      .map((engineBotId) => {
        const threadId = engineBotId.startsWith("mb-") ? engineBotId.slice(3) : engineBotId;
        return state.bots.find((b) => b.threadId === threadId || b.id === engineBotId);
      })
      .filter((bot): bot is Bot => Boolean(bot)),
    [group.bot_ids, state.bots],
  );

  const nameOf = (from: string) => {
    if (isUserEntry(from)) return polish ? "Ty" : "You";
    const threadId = from.startsWith("mb-") ? from.slice(3) : from;
    const bot = state.bots.find((b) => b.id === from || b.threadId === threadId);
    return bot ? botDisplayName(bot, polish ? "pl" : "en") : from;
  };
  const botOf = (from: string) => {
    const threadId = from.startsWith("mb-") ? from.slice(3) : from;
    return state.bots.find((b) => b.id === from || b.threadId === threadId) ?? null;
  };

  // Pokoje grupy narastają: budżet zamyka jeden i otwiera następny, więc
  // historia to WSZYSTKIE pokoje tej grupy po czasie, nie tylko ten otwarty.
  const roomEntries: Entry[] = state.rooms
    .filter((room) => room.groupId === group.id)
    .flatMap((room) => room.transcript.map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at })));
  const entries = (roomEntries.length ? roomEntries : legacy).slice().sort((a, b) => a.at - b.at);

  // Pasek maskotki pokazuje tego członka, który właśnie odpowiada — a gdy
  // nikt nie pracuje, pierwszego z listy (composer musi mieć jakiegoś bota).
  const answering = members.find((bot) => state.streaming[bot.threadId] !== undefined || state.runtime[bot.threadId] || bot.busy)
    ?? members[0]
    ?? null;

  const atEnd = () => {
    const node = scrollRef.current;
    return !node || node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };
  const streamingNow = answering ? state.streaming[answering.threadId] : undefined;
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries.length, follow, streamingNow]);

  const send = (text: string) => {
    // Pętla jest sekwencyjna i potrafi trwać minuty; `false` zostawia tekst w
    // polu, zamiast go po cichu zjeść.
    if (!text || busy) return false;
    setBusy(true);
    setError(null);
    setFollow(true);
    api(`/api/groups/${group.id}/chat`, { method: "POST", body: JSON.stringify({ message: text }) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
    return true;
  };

  return (
    <main className="animate-panel-in flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header — ten sam rytm co zwykły panel agenta */}
      <div data-shell-header className="flex items-center px-5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {members.length > 0 ? (
            <div className="flex -space-x-2 shrink-0">
              {members.slice(0, 3).map((bot) => (
                <MausAvatar key={bot.id} color={bot.color} shape="blob" state={GROUP_AVATAR_STATE} size={28} animated={false} />
              ))}
            </div>
          ) : (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
              <Users size={16} />
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-ink">{group.name || (polish ? "Grupa" : "Group")}</div>
            <div className="truncate text-[11px] text-ink-secondary">
              {members.map((bot) => botDisplayName(bot, polish ? "pl" : "en")).join(", ")}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            const member = members[0];
            if (member) dispatch({ type: "selectComputer", id: member.id });
            dispatch({ type: "toggleComputer", open: true });
          }}
          className="ml-auto rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"
          title={polish ? "Otwórz komputer bota" : "Open bot computer"}
          aria-label={polish ? "Otwórz komputer bota" : "Open bot computer"}
        >
          <Monitor size={16} />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
          onWheel={(e) => { if (e.deltaY < 0) setFollow(false); else if (atEnd()) setFollow(true); }}
          onScroll={() => { if (!follow && atEnd()) setFollow(true); }}
        >
          <div className="flex w-full flex-col gap-1 pb-10">
            {entries.length === 0 && (
              <div className="mt-8 flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
                <Users size={22} />
                <div className="text-[13px] font-medium text-ink">{polish ? "Brak wiadomości" : "No messages yet"}</div>
                <span className="text-[12px]">
                  {polish
                    ? "Napisz do całej grupy. Odpowie ten bot, do którego zadanie pasuje."
                    : "Write to the whole group. Whichever bot the task fits answers."}
                </span>
              </div>
            )}
            {entries.map((entry) => {
              const entryBot = isUserEntry(entry.from) ? null : botOf(entry.from);
              return isUserEntry(entry.from) ? (
                <div key={entry.id} className="flex w-full justify-end">
                  <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl bg-bubble-user px-2 py-[5px] text-[14px] leading-[1.45] text-ink">
                    {entry.text}
                  </div>
                </div>
              ) : (
                <div key={entry.id} className="flex w-full justify-start gap-2.5">
                  {entryBot && (
                    <MausAvatar color={entryBot.color} shape="blob" state={GROUP_AVATAR_STATE} size={28} animated={false} />
                  )}
                  <div className="min-w-0 max-w-[90%]">
                    <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
                      <span className="text-[13px] font-semibold text-ink">{nameOf(entry.from)}</span>
                      <span className="text-[11px] text-ink-secondary">{formatTime(entry.at)}</span>
                    </div>
                    <div className="rounded-2xl bg-card px-2 py-[5px] text-[14px] leading-[1.45] text-ink">
                      <ChatMarkdown text={formatPeerEnvelope(entry.text)} compact />
                    </div>
                  </div>
                </div>
              );
            })}
            {/* Tylko w trakcie NASZEJ tury: `answering` bywa zajęty własnym
                czatem 1:1, a jego strumień nie jest treścią grupy. */}
            {busy && answering && state.streaming[answering.threadId] !== undefined && (
              <div className="flex w-full justify-start">
                <div className="max-w-[90%] rounded-2xl bg-card px-2 py-[5px] text-[14px] leading-[1.45] text-ink">
                  <ChatMarkdown text={state.streaming[answering.threadId]} streaming compact />
                  <span className="ml-0.5 inline-block h-[13px] w-[2px] animate-pulse bg-ink-secondary align-middle" />
                </div>
              </div>
            )}
            {busy && !answering?.busy && (
              <div className="flex items-center gap-2 px-1 text-[12px] text-ink-secondary">
                <Loader2 size={12} className="animate-spin" />
                {polish ? "Wysyłam do grupy…" : "Sending to the group…"}
              </div>
            )}
            {error && (
              <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>
            )}
          </div>
        </div>
        {!follow && (
          <button
            onClick={() => { setFollow(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }}
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          >
            <ArrowDown size={13} /> {polish ? "Przejdź do najnowszych" : "Jump to latest"}
          </button>
        )}
      </div>

      {answering ? (
        <Composer bot={answering} onSend={send} />
      ) : (
        // Grupa, ktorej wszystkie boty skasowano: bez bota nie ma czego karmic
        // composerem (model, zalaczniki, pasek maskotki), wiec zamiast pustego
        // dolu mowimy wprost, dlaczego nie da sie tu pisac.
        <div className="px-5 py-4 text-[12.5px] text-ink-secondary">
          {polish ? "Ta grupa nie ma juz zadnego bota." : "This group has no bots left."}
        </div>
      )}
    </main>
  );
}
