import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { useLanguage } from "@/lib/language";
import { expiredLoginTool, requestCliLogin } from "@/lib/cliLogin";

/**
 * multibot: harness stracił logowanie (wygasły OAuth, cofnięty klucz) — bot nie
 * odpisze, dopóki człowiek go nie odnowi. Serwer parkuje bota na
 * `needsAttention` (server/auth-failure.ts), a to jest jedyny przycisk, który
 * to naprawia: otwiera ustawienia z gotowym oknem logowania danego CLI.
 * Znika sam, bo następna udana tura czyści `needsAttention`.
 */
export function AuthExpiredBanner({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [dismissed, setDismissed] = useState<string | null>(null);
  const attention = bot.needsAttention ?? null;
  const tool = expiredLoginTool(attention);
  if (!tool || dismissed === attention) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">
        <KeyRound size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">{attention}</span>
        <button
          onClick={() => {
            requestCliLogin(tool);
            dispatch({ type: "toggleAppSettings", open: true });
          }}
          className="shrink-0 rounded-md bg-warning/20 px-2 py-1 text-[12px] font-medium hover:bg-warning/30"
        >
          {polish ? "Odśwież logowanie" : "Refresh login"}
        </button>
        <button
          onClick={() => setDismissed(attention)}
          className="shrink-0 rounded-md p-1 hover:bg-warning/20"
          title={polish ? "Ukryj" : "Dismiss"}
          aria-label={polish ? "Ukryj" : "Dismiss"}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
