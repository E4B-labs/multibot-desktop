/** Tytuł wiersza = nazwy znanych członków po przecinku. */
export function groupRowTitle(memberNames: string[]): string {
  return memberNames.join(", ");
}

export const MAX_GROUP_MEMBERS = 12;

export type GroupAvatarLayout = "solo" | "pair" | "trio" | "stack";

/** Układ klastra awatarów w wierszu grupy.
 *
 *  `members` to bot, których sidebar potrafi narysować, `totalCount` to pełny
 *  skład z `bot_ids`. Te dwie liczby się rozjeżdżają: skasowanie bota nie
 *  wyjmuje go z grupy, więc `bot_ids` niesie identyfikatory bez bota. Dlatego
 *  układ dla składów do trzech wybieramy po tym, ile awatarów DA SIĘ narysować
 *  — inaczej para z jednym żywym botem rysowałaby jeden mały awatar przy lewej
 *  krawędzi i pustą połowę pudełka. Plakietka „+N" zostaje dokładką do stosu i
 *  zawsze domyka licznik do pełnego składu. */
export function groupAvatarLayout<T>(
  members: T[],
  totalCount = members.length,
): { layout: GroupAvatarLayout; shown: T[]; hiddenCount: number } {
  const total = Math.max(0, totalCount);
  if (total >= 4) {
    const shown = members.slice(0, 2);
    return { layout: "stack", shown, hiddenCount: total - shown.length };
  }
  const known = Math.min(members.length, total);
  const layout: GroupAvatarLayout = known <= 1 ? "solo" : known === 2 ? "pair" : "trio";
  return { layout, shown: members.slice(0, known), hiddenCount: 0 };
}
