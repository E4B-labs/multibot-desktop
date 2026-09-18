// multibot: ekran „Zużycie" per bot. Backend liczył tokeny i tury od dawna
// (`workspace.usage`, `GET /api/bots/:id/usage`), tylko nikt tego nigdy nie
// widział. Panel jest wyłącznie oknem na te cztery liczby — nic nie zapisuje.
//
// Nie ma tu wykresu „ostatnie 7 dni": serwer trzyma same sumy narastające
// (`server/workspace.ts`), więc dzienny rozkład musiałby być zmyślony.
import { ChevronLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Bot } from "@/state/store";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import { Spinner } from "./Loading";
import { SidePanel } from "./ResizablePanel";

/** Kształt odpowiedzi `GET /api/bots/:id/usage` (`WorkspaceUsage`). */
export type BotUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  turns: number;
};

export const EMPTY_USAGE: BotUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, turns: 0 };

/** Serwer nie obiecuje typów liczbowych po deserializacji, a panel bez liczby
 * pokazałby „NaN" zamiast zera. */
export function parseUsage(body: unknown): BotUsage {
  const raw = (body ?? {}) as Record<string, unknown>;
  const num = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  };
  return {
    prompt_tokens: num(raw.prompt_tokens),
    completion_tokens: num(raw.completion_tokens),
    total_tokens: num(raw.total_tokens),
    turns: num(raw.turns),
  };
}

/** Grupowanie tysięcy wg języka interfejsu — 128345 czyta się gorzej niż 128 345. */
export function formatTokens(value: number, polish: boolean): string {
  const safe = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  return safe.toLocaleString(polish ? "pl-PL" : "en-US");
}

/** Średnia na turę: jedyna liczba, której serwer nie podaje, a która mówi,
 * czy bot pali tokeny na tury, czy na jedną wielką rozmowę. */
export function tokensPerTurn(usage: BotUsage): number {
  return usage.turns > 0 ? Math.round(usage.total_tokens / usage.turns) : 0;
}

/** „1 turns" i „1 tur" wyglądają jak błąd danych, a nie jak liczba tur.
 * Polski ma trzy formy: 1 tura, 2–4 tury, reszta tur (z wyjątkiem 12–14). */
export function turnsLabel(turns: number, polish: boolean): string {
  const n = Math.abs(Math.round(Number.isFinite(turns) ? turns : 0));
  if (!polish) return n === 1 ? "turn" : "turns";
  if (n === 1) return "tura";
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? "tury" : "tur";
}

export function usageRows(usage: BotUsage, polish: boolean): { key: string; label: string; value: string }[] {
  return [
    { key: "prompt", label: polish ? "Tokeny wejściowe" : "Input tokens", value: formatTokens(usage.prompt_tokens, polish) },
    { key: "completion", label: polish ? "Tokeny wyjściowe" : "Output tokens", value: formatTokens(usage.completion_tokens, polish) },
    { key: "turns", label: polish ? "Tury" : "Turns", value: formatTokens(usage.turns, polish) },
    {
      key: "perTurn",
      label: polish ? "Średnio na turę" : "Average per turn",
      value: formatTokens(tokensPerTurn(usage), polish),
    },
  ];
}

/** Licznik rośnie w trakcie tury, więc panel odświeża się sam — inaczej
 * otwarty obok pracującego bota pokazywałby stan sprzed minuty. */
export const POLL_MS = 5000;

/** `stop` = nie ma po co pytać dalej (bota już nie ma). `retry` = jednorazowy
 * błąd: sieć mrugnęła, serwer się restartuje. */
export type PollResult = "ok" | "retry" | "stop";

export function pollUsage(load: () => Promise<PollResult>, intervalMs = POLL_MS): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const run = () => void load().then((result) => { if (result === "stop") stop(); });
  run();
  // `.then` powyżej leci mikrozadaniem, więc `timer` jest już przypisany,
  // zanim pierwsza odpowiedź może poprosić o zatrzymanie.
  timer = setInterval(run, intervalMs);
  return stop;
}

/** Surowy numer statusu nic nie mówi — panel ma powiedzieć, co się stało. */
export function usageErrorMessage(status: number, polish: boolean): string {
  if (status === 404) return polish ? "Tego bota już nie ma." : "This bot no longer exists.";
  if (status === 401 || status === 403) {
    return polish ? "Brak dostępu do zużycia tego bota." : "You cannot see this bot's usage.";
  }
  if (status === 0) return polish ? "Brak połączenia z serwerem." : "No connection to the server.";
  if (status >= 500) {
    return polish ? `Serwer nie oddał zużycia (błąd ${status}).` : `The server could not return usage (error ${status}).`;
  }
  return polish ? `Nie udało się pobrać zużycia (${status}).` : `Could not load usage (${status}).`;
}

export function UsagePanel({ bot, onBack }: { bot: Bot; onBack: () => void }) {
  const polish = useLanguage() === "pl";
  const [usage, setUsage] = useState<BotUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<PollResult> => {
    let response: Response;
    try {
      response = await authFetch(`/api/bots/${bot.id}/usage`);
    } catch {
      // Serwer na telefonie znika na chwilę przy przełączeniu sieci — to nie
      // powód, żeby przestać pytać.
      setError(usageErrorMessage(0, polish));
      return "retry";
    }
    if (!response.ok) {
      setError(usageErrorMessage(response.status, polish));
      return response.status === 404 ? "stop" : "retry";
    }
    setUsage(parseUsage(await response.json().catch(() => ({}))));
    setError(null);
    return "ok";
  }, [bot.id, polish]);

  useEffect(() => pollUsage(load), [load]);

  return (
    <SidePanel
      storageKey="multibot.panelWidth.usage"
      defaultWidth={320}
      label={polish ? "Zmień szerokość panelu zużycia" : "Resize usage panel"}
      className="border-l border-hairline/40"
    >
      <div data-shell-header className="flex items-center justify-between px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={polish ? "Wstecz" : "Back"}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[14px] font-semibold text-ink">{polish ? "Zużycie" : "Usage"}</span>
        <button
          type="button"
          onClick={() => void load()}
          aria-label={polish ? "Odśwież" : "Refresh"}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="text-[12px] text-ink-secondary">
          {polish
            ? `Tokeny i tury zużyte przez bota ${botDisplayName(bot, "pl")} od początku.`
            : `Tokens and turns ${botDisplayName(bot, "en")} has used so far.`}
        </div>

        {usage == null && !error && (
          <div className="mt-6 flex items-center justify-center gap-2 text-[13px] text-ink-secondary">
            <Spinner size={13} /> {polish ? "Wczytywanie…" : "Loading…"}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl bg-card p-3 text-[13px] text-danger">{error}</div>
        )}

        {usage && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="rounded-xl bg-card p-3">
              <div className="text-[12px] text-ink-secondary">{polish ? "Tokeny razem" : "Total tokens"}</div>
              <div data-usage-total className="mt-0.5 text-[28px] font-semibold leading-tight text-ink">
                {formatTokens(usage.total_tokens, polish)}
              </div>
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                {formatTokens(usage.turns, polish)} {turnsLabel(usage.turns, polish)}
              </div>
            </div>

            <div className="rounded-xl bg-card">
              {usageRows(usage, polish).map((row, index) => (
                <div
                  key={row.key}
                  className={
                    "flex items-center justify-between gap-3 px-3 py-2.5" +
                    (index > 0 ? " border-t border-hairline/40" : "")
                  }
                >
                  <span className="text-[13px] text-ink-secondary">{row.label}</span>
                  <span className="text-[14px] font-medium tabular-nums text-ink">{row.value}</span>
                </div>
              ))}
            </div>

            {usage.total_tokens === 0 && usage.turns === 0 && (
              <div className="px-1 text-[12px] text-ink-secondary">
                {polish
                  ? "Ten bot jeszcze nie przepracował żadnej tury."
                  : "This bot has not run a turn yet."}
              </div>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  );
}
