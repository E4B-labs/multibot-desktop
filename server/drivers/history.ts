// multibot: odtworzenie CAŁEJ rozmowy, gdy sesja dostawcy przepadła.
//
// Drivery CLI (codex, claude) trzymają kontekst rozmowy PO STRONIE CLI i
// wznawiają go kursorem (`thread/resume`, `--resume`). Gdy sesji nie da się
// wznowić — wątek codeksa skasowany/po aktualizacji CLI, kursora nigdy nie
// było, albo `cursorPlan` świadomie zakłada nowy wątek, bo tura wnosi serwer
// MCP, którego stary wątek nie zna (każdy bump AGENTS_TOOLS_VERSION /
// COMPUTER_TOOLS_VERSION robi to całej flocie) — CLI startuje z PUSTYM
// kontekstem i bot "zapomina wszystko, co było wcześniej".
//
// Harness ma całą rozmowę na dysku (`messages-<threadId>.json`), więc oddaje
// ją nowej sesji raz, jako pierwszy blok tury. Budżet znakowy pilnuje, żeby
// bardzo długi wątek nie wysadził okna kontekstu — najstarsze lecą pierwsze.
import type { SendTurnInput } from "../contracts.ts";

type Transcript = NonNullable<SendTurnInput["transcript"]>;

/** Górny limit odtwarzanej historii w znakach (`MULTIBOT_HISTORY_MAX_CHARS`). */
export const DEFAULT_HISTORY_MAX_CHARS = 200_000;

export function historyMaxChars(): number {
  const raw = Number(process.env.MULTIBOT_HISTORY_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_HISTORY_MAX_CHARS;
}

/** Ostatnie wiadomości mieszczące się w budżecie znaków; najstarsze odpadają
 *  pierwsze, kolejność zostaje chronologiczna. */
export function trimTranscript<T extends { text: string }>(list: readonly T[], maxChars = historyMaxChars()): T[] {
  let total = 0;
  let from = list.length;
  while (from > 0) {
    total += (list[from - 1].text?.length ?? 0) + 1;
    if (total > maxChars) break;
    from--;
  }
  return list.slice(from);
}

/** Rozmowa dotychczasowa jako jeden blok tekstu z etykietami mówców — pusty
 *  string, gdy nie ma czego odtwarzać. */
export function historyBlock(transcript: SendTurnInput["transcript"], maxChars = historyMaxChars()): string {
  const usable: Transcript = (transcript ?? []).filter((m) => typeof m.text === "string" && m.text.trim());
  if (!usable.length) return "";
  const kept = trimTranscript(usable, maxChars);
  if (!kept.length) return "";
  const dropped = usable.length - kept.length;
  return [
    "[MultiBot] Conversation so far — this provider session is new, the conversation is NOT. Treat everything below as your own memory of this chat; do not greet the user as if you had just met them.",
    dropped ? `(${dropped} oldest message(s) omitted — history longer than the replay budget)` : "",
    ...kept.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text.trim()}`),
    "[MultiBot] End of earlier conversation. The next message is the new one.",
  ]
    .filter(Boolean)
    .join("\n");
}
