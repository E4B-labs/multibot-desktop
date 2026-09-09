// multibot: find-in-chat — trafienia liczysz po stronie klienta, bo cały
// transkrypt bota i tak siedzi w storze (port z MultiBot #437, tam był
// potrzebny endpoint /api/search, bo ich store nie trzyma pełnej listy).
import type { Message } from "@/state/store";

export function findMessageHits(messages: Message[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return messages
    .filter(
      (message) =>
        message.kind === "text" &&
        typeof message.text === "string" &&
        message.text.toLocaleLowerCase().includes(needle),
    )
    .map((message) => message.id);
}
