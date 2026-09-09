// multibot: JEDNA pigułka bota — awatar plus nazwa, w owalu. Rysuje się nią
// KAŻDE wystąpienie bota wewnątrz treści wiadomości, niezależnie od drogi,
// którą do niej doszliśmy:
//   - wzmianka `@Nazwa` w markdownie bota (ChatMarkdown, wtyczka `mentions`),
//   - nadawca koperty bot→bot w dymku roli „user" (`PeerBadge` niżej) — ten
//     dymek leci czystym tekstem, nie markdownem, więc wtyczka wzmianek nigdy
//     się w nim nie odpala i nazwa zostawałaby surowa.
// Wcześniej obie ścieżki miały własną kopię tego samego markupu w dwóch
// plikach i rozjeżdżały się po kolei (kopia w webui telefonu zgubiła
// `avatarUrl`, więc bot z własnym zdjęciem pokazywał tam maskotkę). Klasy
// stoją tu raz — `BOT_CHIP_CLASS` jest jedynym miejscem, gdzie się je zmienia.
import { useStore } from "@/state/store";
import { useLanguage } from "@/lib/language";
import { normalizeState } from "@/lib/mascot";
import { botDisplayName } from "@/lib/botNames";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";

type ChipBot = ReturnType<typeof useStore>["state"]["bots"][number];

export const BOT_CHIP_CLASS =
  "inline-flex translate-y-px items-center gap-1 rounded-full bg-raised px-2 py-0.5 align-middle text-[13px] font-medium text-ink";

/** Bot znany aplikacji: awatar (własne zdjęcie, gdy jest) + nazwa wyświetlana.
 *  Bez małpki — owal z awatarem już mówi, że to bot, a „@" zostawiało dwa
 *  różne zapisy tej samej rzeczy. */
export function BotChip({ bot, className }: { bot: ChipBot; className?: string }) {
  const polish = useLanguage() === "pl";
  return (
    <span className={cn(BOT_CHIP_CLASS, className)}>
      <BotAvatar
        color={bot.color}
        avatarUrl={bot.avatarUrl}
        shape={bot.mascotShape}
        state={normalizeState(bot.mascotExpression) ?? "happy"}
        size={16}
        animated={false}
      />
      {botDisplayName(bot, polish ? "pl" : "en")}
    </span>
  );
}

/** Nadawca koperty bot→bot. Bywa botem, którego już nie ma — wtedy zostaje
 *  sama nazwa z koperty, bez awatara, zamiast pustego miejsca. */
export function PeerBadge({ name }: { name: string }) {
  const { state } = useStore();
  const bot = state.bots.find((b) => b.name.toLowerCase() === name.toLowerCase());
  if (!bot) return <span className={cn(BOT_CHIP_CLASS, "mr-1.5")}>{name}</span>;
  return <BotChip bot={bot} className="mr-1.5" />;
}
