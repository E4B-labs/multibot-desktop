// multibot: live team map (port z upstreamu, TeamMapPage → Panel).
// Polls GET /api/team-map co 3s; krawędzie live z snapshotu, sekcje z rostra
// botów. Droga awaryjna, gdy backend nie ma delegacji: pokazuje same sekcje.
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "@/state/store";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import { BotAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { Skeleton } from "./Loading";
import {
  buildTeamMapEdges,
  buildTeamMapSections,
  EMPTY_TEAM_MAP_SNAPSHOT,
  teamMapStatus,
  type TeamMapSnapshot,
} from "@/lib/team-map";

export function TeamMapPanel({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const polish = useLanguage() === "pl";
  const [snapshot, setSnapshot] = useState<TeamMapSnapshot>(EMPTY_TEAM_MAP_SNAPSHOT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await authFetch("/api/team-map");
        if (!alive || !res.ok) return;
        const body = (await res.json()) as TeamMapSnapshot;
        setSnapshot(body);
      } catch {
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const sections = buildTeamMapSections(state.bots);
  const edges = buildTeamMapEdges(state.bots, snapshot);

  return (
    <div
      // multibot: `data-shell-overlay` — ta sama pułapka co w PluginsPanel:
      // bez niej okno bez ramki zostawia w górnych 72 px region `drag`
      // z nagłówka spod spodu i kliknięcia tam nie docierają (styles.css, 5).
      data-shell-overlay
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-[880px] max-w-full flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-panel shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-3">
          <span className="text-[15px] font-semibold text-ink">{polish ? "Mapa zespołu" : "Team map"}</span>
          <button onClick={onClose} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {!loaded ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </div>
          ) : (
          <>
          {edges.length > 0 && (
            <div className="mb-5 rounded-xl bg-card p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                {polish ? "Połączenia" : "Connections"}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {edges.map((edge) => {
                  const a = state.bots.find((b) => b.id === edge.sourceBotId);
                  const b = state.bots.find((bot) => bot.id === edge.targetBotId);
                  if (!a || !b) return null;
                  const tone =
                    edge.state === "running" ? "bg-accent text-white" : edge.state === "queued" ? "bg-warning text-white" : "bg-raised text-ink-secondary";
                  return (
                    <span
                      key={`${edge.sourceBotId}:${edge.targetBotId}`}
                      className={`rounded-full px-2.5 py-1 text-[11.5px] ${tone}`}
                      title={edge.reason ?? edge.groupId ?? edge.state}
                    >
                      {a.name} ⇄ {b.name} · {edge.state}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {sections.map((section) => (
              <div key={section.key || "__general__"} className="rounded-xl border border-hairline/40 bg-card p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-ink">{section.name}</span>
                  <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-ink-secondary">
                    {section.members.length + section.chiefs.length}
                  </span>
                </div>
                {section.chiefs.length > 0 && (
                  <div className="mb-2">
                    <div className="mb-1 text-[11px] uppercase tracking-[0.08em] text-ink-secondary">Chiefs</div>
                    <div className="flex flex-wrap gap-2">
                      {section.chiefs.map((bot) => {
                        const s = teamMapStatus(bot);
                        return (
                          <span
                            key={bot.id}
                            className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-2 py-1 text-[12px] text-ink"
                            title={s.label}
                          >
                            <BotAvatar color={(bot as unknown as { color: string }).color as never} shape={(bot as unknown as { shape: unknown }).shape as never} state={stateForBot(bot as never)} size={20} animated={false} />
                            {botDisplayName(bot, polish ? "pl" : "en")} <span className={`size-1.5 rounded-full ${s.tone === "success" ? "bg-emerald-500" : s.tone === "warning" ? "bg-warning" : s.tone === "danger" ? "bg-danger" : "bg-ink-secondary/50"}`} />
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {section.members.map((bot) => {
                    const s = teamMapStatus(bot);
                    return (
                      <span
                        key={bot.id}
                        className="flex items-center gap-1.5 rounded-full bg-raised px-2 py-1 text-[12px] text-ink"
                        title={s.label}
                      >
                        <BotAvatar color={(bot as unknown as { color: string }).color as never} shape={(bot as unknown as { shape: unknown }).shape as never} state={stateForBot(bot as never)} size={18} animated={false} />
                        {botDisplayName(bot, polish ? "pl" : "en")}
                      </span>
                    );
                  })}
                  {section.members.length === 0 && section.chiefs.length === 0 && (
                    <span className="text-[12px] text-ink-secondary">{polish ? "Brak botów" : "No bots"}</span>
                  )}
                </div>
              </div>
            ))}
            {sections.length === 0 && <span className="text-[13px] text-ink-secondary">{polish ? "Brak zespołów" : "No teams"}</span>}
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
