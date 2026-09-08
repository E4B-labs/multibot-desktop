// multibot: prawy panel grupy — otwiera się od razu po wejściu w grupę, w tym
// samym slocie co ustawienia bota czy rutyny. Sam skład grupy i skrót do
// rutyn; zero animacji, zero ramek, czarne tło jak reszta.
import { Users } from "lucide-react";
import { useStore, type Bot, type EngineGroup } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { GROUP_AVATAR_STATE } from "@/lib/mascot";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";

export function GroupMembersPanel({ group }: { group: EngineGroup }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";

  const members: Bot[] = group.bot_ids
    .map((engineBotId) => {
      const threadId = engineBotId.startsWith("mb-") ? engineBotId.slice(3) : engineBotId;
      return state.bots.find((b) => b.threadId === threadId || b.id === engineBotId);
    })
    .filter((bot): bot is Bot => Boolean(bot));

  return (
    <aside className="animate-panel-in flex h-full w-[360px] shrink-0 flex-col bg-panel">
      <div data-shell-header className="flex items-center px-5 py-3">
        <span className="text-[15px] font-semibold text-ink">{polish ? "Członkowie" : "Members"}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-3">
        <div className="flex flex-col gap-0.5">
          {members.map((bot) => (
            <button
              key={bot.id}
              type="button"
              onClick={() => { dispatch({ type: "toggleGroup", group: null }); dispatch({ type: "select", id: bot.id }); }}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised"
            >
              <MausAvatar color={bot.color} shape="blob" state={GROUP_AVATAR_STATE} size={28} animated={false} />
              <span className="truncate text-[14px] text-ink">{botDisplayName(bot, polish ? "pl" : "en")}</span>
            </button>
          ))}
          {members.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-ink-secondary">
              <Users size={16} /> {polish ? "Brak botów" : "No bots"}
            </div>
          )}
        </div>
        <div className="px-2 pt-3 text-[12.5px] text-ink-secondary">
          {polish ? "Utwórz więcej Botów, aby dodać je tutaj." : "Create more Bots to add them here."}
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 px-6 pb-8 pt-6 text-center">
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          {polish
            ? "Rutyny to powtarzalne zadania, które ten Bot uruchamia zgodnie z harmonogramem."
            : "Routines are repeating tasks this Bot runs on a schedule."}
        </p>
        <button
          type="button"
          disabled={members.length === 0}
          onClick={() => {
            if (!members[0]) return;
            dispatch({ type: "select", id: members[0].id });
            dispatch({ type: "toggleRoutines", open: true });
          }}
          className="rounded-xl bg-inset px-4 py-2 text-[13px] font-medium text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          {polish ? "Utwórz rutynę" : "Create routine"}
        </button>
      </div>
    </aside>
  );
}
