import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, X } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
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

/**
 * multibot: karta w transkrypcie (`kind: "login"`, server/store.ts) — stoi tam,
 * gdzie tura padła, i zostaje po przełączeniu bota, inaczej niż banerka wyżej.
 * Ten sam przycisk co w banerce: ustawienia z gotowym oknem logowania tego
 * CLI. Serwer przełącza ją na „Zalogowano ponownie" po udanym logowaniu albo
 * po następnej udanej turze (`login.signedIn`).
 */
export function LoginExpiredCard({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const tool = message.login?.tool ?? "";
  const signedIn = message.login?.signedIn === true;
  return (
    <div className="flex justify-start" data-testid="login-expired-card">
      <div className={`w-full max-w-[440px] rounded-2xl border bg-card p-4 ${signedIn ? "border-success/30" : "border-warning/40"}`}>
        <div className="flex items-start gap-3">
          <span className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${signedIn ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>
            {signedIn ? <CheckCircle2 size={18} /> : <KeyRound size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-ink">
              {signedIn ? (polish ? "Zalogowano ponownie" : "Signed in again") : polish ? "Logowanie wygasło" : "Login expired"}
            </div>
            <div className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
              {signedIn
                ? polish ? `${tool} znów odpowiada. Napisz „kontynuuj”, żeby bot wrócił do tematu.` : `${tool} is back. Say "continue" to bring the bot back to the topic.`
                : polish
                  ? `Sesja ${tool} wygasła i nie dała się odświeżyć, więc bot nie mógł odpowiedzieć. Zaloguj się ponownie — bot podejmie temat.`
                  : `The ${tool} session expired and could not be refreshed, so the bot could not answer. Sign in again and the bot picks the topic back up.`}
            </div>
            {!signedIn && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => dispatch({ type: "toggleAppSettings", open: true, cliLogin: tool })}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
                >
                  {polish ? "Odśwież logowanie" : "Refresh login"}
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "toggleAppSettings", open: true })}
                  className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:text-ink"
                >
                  {polish ? "Otwórz ustawienia" : "Open settings"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
