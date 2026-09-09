// multibot: flat replies (port z upstreamu #437, ReplyQuote.tsx)
import { X } from "lucide-react";
import type { Message } from "@/state/store";
import { getLanguage } from "@/lib/language";

export function replySnippet(text: string, limit = 160): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

export function replyAuthor(message: Message, botName = getLanguage() === "pl" ? "Asystent" : "Assistant"): string {
  return message.role === "user" ? "You" : botName;
}

/** Pasek „odpowiasz na…" — nad composerem (tryb pisania) albo w dymku
 * (kompaktowy, klik skacze do cytowanej wiadomości). */
export function ReplyQuote({
  message,
  botName,
  onJump,
  onClear,
  compact,
}: {
  message?: Message;
  botName?: string;
  onJump?: () => void;
  onClear?: () => void;
  compact?: boolean;
}) {
  if (!message) return null;
  const body = (
    <>
      <span className="font-medium">{replyAuthor(message, botName)}</span>
      <span className="opacity-80"> · {replySnippet(message.text ?? "")}</span>
    </>
  );
  if (compact) {
    return (
      <button
        type="button"
        onClick={onJump}
        className="mb-1.5 block max-w-full truncate rounded-lg border-l-2 border-accent/70 bg-raised/70 px-2 py-1 text-left text-[12px] text-ink-secondary hover:text-ink"
        title={replySnippet(message.text ?? "")}
      >
        {body}
      </button>
    );
  }
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-hairline/40 border-l-2 border-l-accent/70 bg-card px-3 py-2 text-[13px] text-ink-secondary">
      <div className="min-w-0 flex-1 truncate">
        <span className="text-ink-secondary/70">Replying to </span>
        {body}
      </div>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Cancel reply"
          className="shrink-0 rounded-md p-1 hover:bg-raised hover:text-ink"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function replyTargetOf(messages: Message[], id?: string): Message | undefined {
  return id ? messages.find((m) => m.id === id) : undefined;
}
