import { useId, useState } from "react";
import { Check, X } from "lucide-react";
import { isApprovalCard, useStore, type Message, type OptionCardData } from "@/state/store";
import { botDisplayName } from "@/lib/botNames";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

/** Stan karty po odpowiedzi: „wysłano do X" do chwili, w której serwer
 * potwierdzi, że bot ją dostał (`delivered`), potem „odebrane". */
export function deliveryLabel(card: OptionCardData, botName: string, polish: boolean): string {
  if (card.delivered) return polish ? "odebrane" : "received";
  return polish ? `wysłano do: ${botName}` : `sent to ${botName}`;
}

/** Karta zgody: podtytuł niesie streszczenie akcji, a gdy autoweryfikacja
 * prośbę przepuściła — także notę z regułą, doklejoną po nowej linii
 * (`server/index.ts`, `request.opened`). Rozdzielamy je, bo w jednym wierszu
 * drobnym drukiem nota zlewała się z poleceniem. */
export function splitApprovalSubtitle(subtitle: string): { action: string; note: string } {
  const nl = subtitle.indexOf("\n");
  if (nl === -1) return { action: subtitle.trim(), note: "" };
  return { action: subtitle.slice(0, nl).trim(), note: subtitle.slice(nl + 1).trim() };
}

export interface ApprovalValue {
  /** Nazwa pola (klucz wejścia narzędzia) albo "" dla jednej gołej wartości. */
  label: string;
  value: string;
}

/** Konkretne wartości, na które człowiek się zgadza. Sterowniki wkładają w
 * streszczenie albo polecenie/adres, albo `JSON.stringify(input)` narzędzia —
 * ten drugi kształt rozkładamy na wiersze klucz → wartość, żeby przed
 * kliknięciem było widać, którego pliku czy adresu to dotyczy. */
export function approvalValues(action: string): ApprovalValue[] {
  const text = action.trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rows = Object.entries(parsed as Record<string, unknown>)
          .map(([label, raw]) => ({
            label,
            value: (typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "")).trim(),
          }))
          .filter((row) => row.value !== "");
        if (rows.length) return rows;
      }
    } catch {
      // Streszczenie bywa ucięte na 200 znakach — wtedy to już nie jest JSON
      // i pokazujemy je tak, jak przyszło.
    }
  }
  return [{ label: "", value: text }];
}

/** Stałe zdanie z baseline: zgoda dotyczy tego, co bot PROPONUJE. */
export function approvalScopeNote(polish: boolean): string {
  return polish
    ? "Zgoda dotyczy proponowanej akcji — nie cofa pracy już wykonanej."
    : "Approval covers the proposed action only; it does not undo work already done.";
}

/** Zakres pojedynczego przycisku: czym różni się „raz" od „zawsze". */
export function optionScopeHint(option: string, polish: boolean): string {
  if (option === "Allow") return polish ? "tylko ta jedna akcja" : "this action only";
  if (option === "Allow for all") return polish ? "zapamiętuje regułę na przyszłość" : "remembers a rule for next time";
  if (option === "Deny") return polish ? "bot tego nie zrobi" : "the bot will not do this";
  return "";
}

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const language = useLanguage();
  const polish = language === "pl";
  const [custom, setCustom] = useState("");
  // Jedyny stan, jakiego checkboxy potrzebują: czy cokolwiek jest zaznaczone.
  // Same zaznaczenia trzyma DOM, odczytuje je `FormData` przy zatwierdzeniu.
  const [anyPicked, setAnyPicked] = useState(false);
  const titleId = useId();
  const card = message.card;
  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (card.answered || !text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };

  const approval = isApprovalCard(card);
  // Karta zgody mówi, o co chodzi, ZANIM człowiek kliknie: co bot chce zrobić,
  // z jakimi wartościami, co oznacza każdy przycisk i czego zgoda nie cofa.
  const { action, note } = splitApprovalSubtitle(approval ? card.subtitle ?? "" : "");
  const values = approval ? approvalValues(action) : [];

  // multibot: po odpowiedzi karta PYTANIA nie znika — zostaje w transkrypcie
  // jako pokwitowanie: o co pytał bot, co człowiek wybrał i czy to do bota
  // doszło. Karta zgody idzie dalej starą ścieżką (podświetlona opcja).
  if (card.answered && !approval) {
    const bot = state.bots.find((b) => b.id === botId);
    const botName = bot ? botDisplayName(bot, language) : polish ? "bota" : "the bot";
    return (
      <div className="w-full max-w-[840px] rounded-xl border border-hairline/50 bg-card px-3 py-2">
        <div className="line-clamp-2 text-[12px] text-ink-secondary">{card.title}</div>
        <div className="mt-0.5 flex items-start gap-2">
          <Check size={14} className="mt-[3px] shrink-0 text-ink-secondary" />
          <span className="text-[14px] text-ink">{card.answered}</span>
        </div>
        <div className="mt-1 text-[11px] text-ink-secondary">
          {deliveryLabel(card, botName, polish)}
        </div>
      </div>
    );
  }

  const multiple = card.multiple === true && card.options.length > 1;
  const rowClass = (i: number) =>
    cn(
      "flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-[15px] text-ink hover:bg-raised/60",
      i > 0 && "border-t border-hairline/40",
    );

  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        {/* multibot: tytułem karty pytania jest samo pytanie. Tło (jeśli bot je
            podał) jedzie pod spodem drobnym drukiem — miejsca jest mało. */}
        <div className="min-w-0">
          <div id={titleId} className="text-[16px] font-semibold text-ink">{card.title}</div>
          {card.subtitle && !approval ? (
            <div className="mt-0.5 text-[12px] leading-snug text-ink-secondary">
              {card.subtitle}
            </div>
          ) : null}
        </div>
        <button
          aria-label={polish ? "Zamknij" : "Dismiss"}
          onClick={() =>
            dispatch({ type: "dismissCard", botId, messageId: message.id })
          }
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {approval && values.length ? (
        <div className="mt-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wide text-ink-secondary">
            {polish ? "Co bot chce zrobić" : "What the bot wants to do"}
          </div>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {values.map((v) => (
              <div key={v.label || v.value} className="min-w-0">
                {v.label ? (
                  <div className="text-[11px] text-ink-secondary">{v.label}</div>
                ) : null}
                <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-ink">
                  {v.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {approval && note ? (
        <div className="mt-2 text-[11px] leading-snug text-ink-secondary">{note}</div>
      ) : null}

      {multiple ? (
        // Natywne checkboxy w `<form>`: `FormData.getAll` oddaje zaznaczone
        // etykiety w kolejności opcji, więc nie ma czego trzymać w stanie, a
        // klawiatura i czytnik ekranu działają bez ani jednego `aria-*`.
        <form
          onChange={(e) => setAnyPicked(new FormData(e.currentTarget).getAll("opt").length > 0)}
          onSubmit={(e) => {
            e.preventDefault();
            answer(new FormData(e.currentTarget).getAll("opt").join(", "));
          }}
        >
          <div role="group" aria-labelledby={titleId} className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
            {card.options.map((opt, i) => (
              <label key={opt} className={rowClass(i)}>
                <input
                  type="checkbox"
                  name="opt"
                  value={opt}
                  className="size-4 shrink-0 accent-accent"
                />
                {opt}
              </label>
            ))}
          </div>
          <button
            type="submit"
            disabled={!anyPicked}
            className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-[15px] font-medium text-accent-ink disabled:opacity-50"
          >
            {polish ? "Zatwierdź" : "Confirm"}
          </button>
        </form>
      ) : (
        <>
          <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
            {card.options.map((opt, i) => (
              <button
                key={opt}
                disabled={!!card.answered}
                onClick={() => answer(opt)}
                className={cn(
                  rowClass(i),
                  card.answered === opt ? "bg-raised" : "disabled:hover:bg-transparent",
                )}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-[12px] font-medium text-ink-secondary">
                  {LETTERS[i]}
                </span>
                <span className="min-w-0">
                  {opt}
                  {approval && optionScopeHint(opt, polish) ? (
                    <span className="block text-[11px] leading-snug text-ink-secondary">
                      {optionScopeHint(opt, polish)}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>

          {!card.answered && (
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && answer(custom)}
              placeholder={polish ? "Wpisz własną odpowiedź" : "Type your own answer"}
              className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
            />
          )}
        </>
      )}

      {approval ? (
        <p className="mt-3 text-[11px] leading-snug text-ink-secondary">{approvalScopeNote(polish)}</p>
      ) : null}
    </div>
  );
}
