/** Tytuł wiersza = nazwy znanych członków po przecinku. */
export function groupRowTitle(memberNames: string[]): string {
  return memberNames.join(", ");
}

export const MAX_GROUP_MEMBERS = 12;

export function groupAvatarLayout<T>(
  members: T[],
  totalCount = members.length,
): { layout: "solo" | "pair" | "trio" | "stack"; shown: T[]; hiddenCount: number } {
  const count = Math.max(0, totalCount);
  if (count <= 1) return { layout: "solo", shown: members.slice(0, 1), hiddenCount: 0 };
  if (count === 2) return { layout: "pair", shown: members.slice(0, 2), hiddenCount: 0 };
  if (count === 3) return { layout: "trio", shown: members.slice(0, 3), hiddenCount: 0 };
  return { layout: "stack", shown: members.slice(0, 2), hiddenCount: count - 2 };
}
