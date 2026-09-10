import { useId, useState } from "react";
import { Check, X } from "lucide-react";
import { useStore, type Message, type OptionCardData } from "@/state/store";
import { botDisplayName } from "@/lib/botNames";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

/** Karta ZGODY, nie pytania: zostaje w starej postaci nawet po odpowiedzi, bo
 * jej podtytuł (co zatwierdzono i jaką regułą) to ślad autoweryfikacji, a
 * pokwitowanie by go skasowało. Warunek na „Allow for all" łapie karty zapisane
 * przed dodaniem `kind` — starych transkryptów nie przepisujemy. */
export function isApprovalCard(card: OptionCardData): boolean {
  return card.kind === "approval" || card.options.includes("Allow for all");
}

/** Stan karty po odpowiedzi: „wysłano do X" do chwili, w której serwer
 * potwierdzi, że bot ją dostał (`delivered`), potem „odebrane". */
export function deliveryLabel(card: OptionCardData, botName: string, polish: boolean): string {
  if (card.delivered) return polish ? "odebrane" : "received";
  return polish ? `wysłano do: ${botName}` : `sent to ${botName}`;
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
  const titleId = useId();
  const card = message.card;
  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (card.answered || !text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };

  const approval = isApprovalCard(card);

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
          {card.subtitle ? (
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

      {multiple ? (
        // Natywne checkboxy w `<form>`: `FormData.getAll` oddaje zaznaczone
        // etykiety w kolejności opcji, więc nie ma czego trzymać w stanie, a
        // klawiatura i czytnik ekranu działają bez ani jednego `aria-*`.
        <form
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
            className="mt-3 w-full rounded-lg bg-accent px-3 py-2.5 text-[15px] font-medium text-accent-ink"
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
                {opt}
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
    </div>
  );
}
