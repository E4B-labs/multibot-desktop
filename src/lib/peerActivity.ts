export interface PeerActivityMessage {
  id: string;
  room?: {
    id: string;
    bot_ids: string[];
    ownerBotId: string;
    event?: "texted" | "received" | "replied";
  };
}

export function peerActivityGroupFor(
  messages: PeerActivityMessage[],
  index: number,
  currentBotId: string,
): PeerActivityMessage[] | null {
  const message = messages[index];
  if (!message) return null;
  const room = message?.room;
  if (!room?.event) return null;
  if (room.event !== "texted" || room.ownerBotId !== currentBotId) return [message];
  const sameBatch = (candidate: PeerActivityMessage | undefined) =>
    candidate?.room?.event === "texted" &&
    candidate.room.ownerBotId === currentBotId &&
    candidate.room.id === room.id;
  let start = index;
  while (start > 0 && sameBatch(messages[start - 1])) start -= 1;
  let end = index;
  while (end + 1 < messages.length && sameBatch(messages[end + 1])) end += 1;
  return messages.slice(start, end + 1);
}
