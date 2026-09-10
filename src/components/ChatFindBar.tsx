import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useLanguage } from "@/lib/language";
import type { ChatFind } from "@/lib/useChatFind";

/** multibot: pasek szukania w transkrypcie bota. Enter/Shift+Enter i ↑↓ skaczą
 * po trafieniach, Escape zamyka. Trafienia zbiera i maluje `useChatFind`
 * (CSS Custom Highlight API), pasek jest tylko polem i licznikiem. */
export function ChatFindBar({ find, onClose }: { find: ChatFind; onClose: () => void }) {
  const polish = useLanguage() === "pl";
  const inputRef = useRef<HTMLInputElement>(null);
  const { raw, setRaw, total, index, move } = find;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="absolute right-4 top-2 z-30 flex items-center gap-1 rounded-xl border border-hairline/40 bg-raised px-2 py-1.5 shadow-lg"
      role="search"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            move(e.shiftKey ? -1 : 1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          }
        }}
        placeholder={polish ? "Szukaj w rozmowie…" : "Find in chat…"}
        className="w-52 bg-transparent px-1 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
      />
      <span className="min-w-10 text-center text-[11.5px] tabular-nums text-ink-secondary">
        {total ? `${index + 1}/${total}` : "0/0"}
      </span>
      <button
        type="button"
        onClick={() => move(-1)}
        disabled={!total}
        aria-label={polish ? "Poprzednie trafienie" : "Previous match"}
        className="rounded-md p-1 text-ink-secondary hover:bg-panel hover:text-ink disabled:opacity-40"
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        onClick={() => move(1)}
        disabled={!total}
        aria-label={polish ? "Następne trafienie" : "Next match"}
        className="rounded-md p-1 text-ink-secondary hover:bg-panel hover:text-ink disabled:opacity-40"
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={polish ? "Zamknij wyszukiwanie" : "Close search"}
        className="rounded-md p-1 text-ink-secondary hover:bg-panel hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  );
}
