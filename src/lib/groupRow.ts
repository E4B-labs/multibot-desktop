/** Tytuł wiersza = nazwy znanych członków po przecinku. */
export function groupRowTitle(memberNames: string[]): string {
  return memberNames.join(", ");
}

export const MAX_GROUP_MEMBERS = 12;

export type GroupAvatarLayout = "solo" | "pair" | "trio";

/** Układ klastra awatarów w wierszu grupy.
 *
 *  `members` to boty, które sidebar potrafi narysować, `totalCount` to pełny
 *  skład z `bot_ids`. Te dwie liczby się rozjeżdżają, bo lista grup
 *  (`useEngineGroups`) i lista botów (`state.bots`) przychodzą osobno: dopóki
 *  ta druga nie dogoni, grupa niesie identyfikator bez bota.
 *
 *  Klaster ma zawsze najwyżej TRZY elementy i układ idzie za ich liczbą, nie za
 *  składem grupy: do trzech członków każdy dostaje własny awatar, od czterech
 *  rysujemy dwa awatary plus plakietkę „+N". Członek, którego nie da się
 *  narysować, wpada do plakietki. Wcześniej układ dla składów do trzech
 *  wybierało `known`, więc trójka z jednym nieznanym botem rysowała się jak
 *  zwykła para i trzeci członek znikał bez śladu. */
export function groupAvatarLayout<T>(
  members: T[],
  totalCount = members.length,
): { layout: GroupAvatarLayout; shown: T[]; hiddenCount: number } {
  const total = Math.max(0, totalCount);
  const shown = members.slice(0, Math.min(total, total <= 3 ? 3 : 2));
  const hiddenCount = total - shown.length;
  const slots = shown.length + (hiddenCount > 0 ? 1 : 0);
  const layout: GroupAvatarLayout = slots <= 1 ? "solo" : slots === 2 ? "pair" : "trio";
  return { layout, shown, hiddenCount };
}
