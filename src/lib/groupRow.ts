/** Tytuł wiersza = nazwy znanych członków po przecinku. */
export function groupRowTitle(memberNames: string[]): string {
  return memberNames.join(", ");
}

/** Kafelek grupy pokazuje do trzech awatarow i liczbe pozostalych czlonkow. */
export function groupAvatarStack<T>(members: T[], totalCount = members.length): { shown: T[]; hiddenCount: number } {
  return { shown: members.slice(0, 3), hiddenCount: Math.max(0, totalCount - 3) };
}
