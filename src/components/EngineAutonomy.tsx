// Provider-neutral access profile. One setting controls every bot tool.
import { useEffect, useState } from "react";
import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { Skeleton } from "./Loading";

type Access = "approval" | "full";

const labels: Record<Access, { en: string; pl: string }> = {
  approval: { en: "Ask for approval", pl: "Pytaj o zgodę" },
  full: { en: "Full Access", pl: "Pełny dostęp" },
};

export function EngineAutonomy({ bot }: { bot: Bot }) {
  const [access, setAccess] = useState<Access>("approval");
  const [status, setStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [error, setError] = useState<string | null>(null);
  const polish = useLanguage() === "pl";

  useEffect(() => {
    api(`/api/bots/${bot.id}/access`)
      .then((value: { access?: string }) => {
        setAccess(value.access === "full" ? value.access : "approval");
        setStatus("ready");
      })
      .catch(() => setStatus("offline"));
  }, [bot.id]);

  const choose = (next: Access) => {
    const previous = access;
    setAccess(next);
    setError(null);
    api(`/api/bots/${bot.id}/access`, { method: "PATCH", body: JSON.stringify({ access: next }) })
      .then((value: { access?: string }) => setAccess(value.access === "full" ? value.access : "approval"))
      .catch((e: unknown) => {
        setAccess(previous);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Dostęp" : "Access"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Zakres działania tego bota" : "What this bot may do"}</div>
      {status === "offline" ? (
        <div className="mt-3 text-[13px] text-ink-secondary">{polish ? "Usługa offline" : "Service offline"}</div>
      ) : status === "ready" ? (
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-inset p-1">
          {(Object.keys(labels) as Access[]).map((item) => (
            <button key={item} onClick={() => choose(item)} className={cn("rounded-md px-2 py-2 text-[12px]", access === item ? "bg-accent text-white" : "text-ink-secondary hover:bg-raised")}>
              {polish ? labels[item].pl : labels[item].en}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-inset p-1">
          <Skeleton className="h-[34px]" />
          <Skeleton className="h-[34px]" />
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
