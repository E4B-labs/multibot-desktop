/** Tytuł wiersza = nazwy znanych członków po przecinku. */
export function groupRowTitle(memberNames: string[]): string {
  return memberNames.join(", ");
}

/** Kafelek grupy pokazuje wszystkie znane awatary w jednym poziomym stosie. */
export function groupAvatarStack<T>(members: T[]): { shown: T[] } {
  return { shown: members };
}
