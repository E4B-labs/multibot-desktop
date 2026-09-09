// multibot: flat replies (port z MultiBot #437, server/replies.ts).
// Cytat NIE zmienia historii wątku — to tylko adnotacja przy jednej
// wiadomości + ogrodzony fragment w prompcie tury, żeby bot wiedział,
// na co odpowiada. Cytowana treść jest treścią użytkownika, więc trafia
// do prompta jako niezaufana (fence), nigdy jako instrukcja.

const EXCERPT_LIMIT = 900;

export function replyExcerpt(text: string, limit = EXCERPT_LIMIT): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

export function resolveReplyTarget(
  messages: Array<{ id: string; role: "bot" | "user"; kind?: string; text?: string }>,
  replyToId: unknown,
): { id: string; role: "bot" | "user"; text?: string } | null {
  if (typeof replyToId !== "string" || !replyToId) return null;
  const target = messages.find((message) => message.id === replyToId);
  if (!target || target.kind === "screen" || !String(target.text ?? "").trim()) return null;
  return target;
}

/** Prompt tury: ogrodzony cytat + właściwa wiadomość użytkownika. */
export function promptWithReply(
  text: string,
  target: { id: string; role: "bot" | "user"; text?: string },
  botName: string,
): string {
  const speaker = target.role === "user" ? "the user" : botName;
  return `[Replying to ${speaker}'s earlier message:\n"""\n${replyExcerpt(String(target.text ?? ""))}\n"""]\n\n${text}`;
}
