import { useState } from "react";
import { Check, X } from "lucide-react";
import { useStore, type Message, type OptionCardData } from "@/state/store";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

/** Odpowiedź, która pojedzie do bota: przy wielokrotnym wyborze to WYBRANE
 * ETYKIETY po przecinku, w kolejności opcji na karcie. Pusty wybór nie jest
 * odpowiedzią — „Zatwierdź" ma wtedy zostać wyłączony. */
export function pickedAnswer(options: string[], picked: ReadonlySet<number>): string {
  return options.filter((_, i) => picked.has(i)).join(", ");
}

/** Stan karty po odpowiedzi: „wysłano do X" do chwili, w której serwer
 * potwierdzi jej przyjęcie (`delivered`), potem „odebrane". */
export function deliveryLabel(card: OptionCardData, botName: string, polish: boolean): string {
  if (card.delivered) return polish ? "odebrane" : "received";
  return polish ? `wysłano do ${botName}` : `sent to ${botName}`;
}

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [custom, setCustom] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set<number>());
  const card = message.card;
  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };

  // multibot: po odpowiedzi karta NIE znika — zostaje w transkrypcie jako
  // pokwitowanie: o co pytał bot, co człowiek wybrał i czy to do bota doszło.
  if (card.answered) {
    const botName = state.bots.find((b) => b.id === botId)?.name ?? (polish ? "bota" : "the bot");
    return (
      <div className="w-full max-w-[840px] rounded-xl border border-hairline/50 bg-card px-3 py-2">
        <div className="truncate text-[12px] text-ink-secondary">{card.title}</div>
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

  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        {/* multibot: tytułem karty jest samo pytanie. Tło (jeśli bot je podał)
            jedzie pod spodem drobnym drukiem — miejsca jest mało. */}
        <div className="min-w-0">
          <div className="text-[16px] font-semibold text-ink">{card.title}</div>
          {card.subtitle ? (
            <div className="mt-0.5 text-[12px] leading-snug text-ink-secondary">
              {card.subtitle}
            </div>
          ) : null}
        </div>
        <button
          onClick={() =>
            dispatch({ type: "dismissCard", botId, messageId: message.id })
          }
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            role={multiple ? "checkbox" : undefined}
            aria-checked={multiple ? picked.has(i) : undefined}
            onClick={() =>
              multiple
                ? setPicked((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(i)) next.add(i);
                    return next;
                  })
                : answer(opt)
            }
            className={cn(
              "flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] text-ink hover:bg-raised/60",
              i > 0 && "border-t border-hairline/40",
              multiple && picked.has(i) && "bg-raised",
            )}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center text-[12px] font-medium",
                multiple ? "rounded border border-hairline" : "rounded-md bg-raised text-ink-secondary",
                multiple && picked.has(i) && "border-transparent bg-ink text-card",
              )}
            >
              {multiple ? (picked.has(i) ? <Check size={13} /> : null) : LETTERS[i]}
            </span>
            {opt}
          </button>
        ))}
      </div>

      {multiple && (
        <button
          disabled={picked.size === 0}
          onClick={() => answer(pickedAnswer(card.options, picked))}
          className="mt-3 w-full rounded-lg bg-ink px-3 py-2.5 text-[15px] font-medium text-card disabled:opacity-40"
        >
          {polish ? "Zatwierdź" : "Confirm"}
        </button>
      )}

      <input
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && answer(custom)}
        placeholder={polish ? "Wpisz własną odpowiedź" : "Type your own answer"}
        className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
      />
    </div>
  );
}
