import { ChevronLeft, Copy, Play, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Bot } from "@/state/store";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import { Spinner } from "./Loading";

type InspectorEvent = { id: string; at: number; type: string; provider: string; itemType?: string; summary?: string; ok?: boolean };

export function InspectorPanel({ bot }: { bot: Bot }) {
  const polish = useLanguage() === "pl";
  const [events, setEvents] = useState<InspectorEvent[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [replaying, setReplaying] = useState(false);
  const load = () => authFetch(`/api/bots/${bot.id}/inspector?limit=100`).then((r) => r.ok ? r.json() : Promise.reject()).then((body) => setEvents(body.events ?? [])).catch(() => {});
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [bot.id]);
  const replay = () => {
    setReplaying(true);
    return authFetch(`/api/bots/${bot.id}/inspector/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: selected.length ? selected : events.map((event) => event.id) }) }).then((r) => r.json()).then((body) => setEvents(body.events ?? [])).catch(() => {}).finally(() => setReplaying(false));
  };
  const close = () => window.dispatchEvent(new CustomEvent("mb:inspector:close"));
  return (
    <aside className="animate-panel-in flex h-full w-[360px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div data-shell-header className="flex items-center justify-between px-4 py-3">
        <button type="button" onClick={close} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={polish ? "Wstecz" : "Back"}><ChevronLeft size={18} /></button>
        <span className="text-[15px] font-semibold text-ink">Inspector</span>
        <button type="button" onClick={close} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={polish ? "Zamknij" : "Close"}><X size={18} /></button>
      </div>
      <div className="flex items-center gap-2 border-b border-hairline/40 px-4 pb-3 text-[12px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate">{botDisplayName(bot, polish ? "pl" : "en")} · {events.length} events</span>
        <button type="button" onClick={() => void load()} title={polish ? "Odśwież" : "Refresh"} className="rounded-md p-1 hover:bg-raised hover:text-ink"><RefreshCw size={14} /></button>
        <button type="button" onClick={() => void replay()} disabled={!events.length || replaying} title={polish ? "Odtwórz zapis" : "Replay captured events"} className="rounded-md p-1 hover:bg-raised hover:text-ink disabled:opacity-40">{replaying ? <Spinner size={14} /> : <Play size={14} />}</button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-1.5">
          {events.map((event) => (
            <label key={event.id} className="flex cursor-pointer gap-2 rounded-lg bg-card px-3 py-2 text-[12px] hover:bg-raised">
              <input type="checkbox" checked={selected.includes(event.id)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, event.id] : current.filter((id) => id !== event.id))} />
              <span className="min-w-0 flex-1"><span className="font-medium text-ink">{event.type}</span><span className="ml-1 text-ink-secondary">{event.itemType ?? event.provider}</span>{event.summary && <span className="mt-0.5 block truncate text-ink-secondary">{event.summary}</span>}</span>
              <button type="button" onClick={(e) => { e.preventDefault(); void navigator.clipboard?.writeText(JSON.stringify(event, null, 2)); }} title="Copy JSON" className="self-start text-ink-secondary hover:text-ink"><Copy size={12} /></button>
            </label>
          ))}
          {!events.length && <div className="py-8 text-center text-[13px] text-ink-secondary">{polish ? "Brak zdarzeń runtime" : "No runtime events yet"}</div>}
        </div>
      </div>
    </aside>
  );
}
