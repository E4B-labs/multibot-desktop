import { useEffect, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { useLanguage } from "@/lib/language";

/** Prefiks `needsAttention` pisany przez serwer (server/auth-failure.ts).
 * Angielski i stały, bo jest znacznikiem maszynowym — zdanie dla człowieka
 * powstaje tutaj, w języku interfejsu. */
export const LOGIN_EXPIRED_PREFIX = "Login expired for ";

/**
 * Które narzędzie CLI prosi o ponowne logowanie — `null`, gdy `needsAttention`
 * mówi o czymkolwiek innym (pytanie bota, captcha, cokolwiek).
 */
export function expiredLoginTool(attention: string | null | undefined): string | null {
  if (!attention || !attention.startsWith(LOGIN_EXPIRED_PREFIX)) return null;
  return /^([a-z0-9-]+)\./i.exec(attention.slice(LOGIN_EXPIRED_PREFIX.length))?.[1] ?? null;
}

/**
 * multibot: harness stracił logowanie (wygasły OAuth, cofnięty klucz) — bot nie
 * odpisze, dopóki człowiek go nie odnowi. Serwer parkuje bota na
 * `needsAttention` (server/auth-failure.ts), a to jest jedyny przycisk, który
 * to naprawia: otwiera ustawienia z gotowym oknem logowania danego CLI.
 * Znika sam — udane logowanie i następna udana tura czyszczą `needsAttention`.
 */
export function AuthExpiredBanner({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  // Klucz z id bota: ChatView żyje dalej przy przełączaniu rozmów, więc samo
  // porównanie treści chowałoby banerkę u KAŻDEGO bota na tym samym CLI.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const attention = bot.needsAttention ?? null;
  const tool = expiredLoginTool(attention);
  // Prośba zgasła (udane logowanie, udana tura) — kolejna ma się pokazać.
  useEffect(() => {
    if (!attention) setDismissed(null);
  }, [attention]);
  if (!tool || dismissed === `${bot.id}:${attention}`) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">
        <KeyRound size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">
          {polish
            ? `Logowanie do ${tool} wygasło. Zaloguj się ponownie.`
            : `Login expired for ${tool}. Sign in again to continue.`}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, cliLogin: tool })}
            className="rounded-md bg-warning/20 px-2 py-1 text-[12px] font-medium hover:bg-warning/30"
          >
            {polish ? "Odśwież logowanie" : "Refresh login"}
          </button>
          <button
            onClick={() => setDismissed(`${bot.id}:${attention}`)}
            className="rounded-md p-1 hover:bg-warning/20"
            title={polish ? "Ukryj" : "Dismiss"}
            aria-label={polish ? "Ukryj" : "Dismiss"}
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
