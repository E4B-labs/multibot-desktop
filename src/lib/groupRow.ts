/** Tytuł wiersza = nazwy znanych członków po przecinku. */
export function groupRowTitle(memberNames: string[]): string {
  return memberNames.join(", ");
}

/** Kafelek grupy w stylu komunikatora: skos z dwóch awatarów, a przy większym
 *  składzie przedni awatar zastępuje kółko „+N" (N = wszyscy oprócz tylnego).
 *  Jeden członek — jeden awatar, bez skosu. */
export function groupAvatarStack<T>(
  members: T[],
  total = members.length,
): { shown: T[]; plus: number } {
  if (total > 2) return { shown: members.slice(0, 1), plus: total - 1 };
  return { shown: members.slice(0, 2), plus: 0 };
}
