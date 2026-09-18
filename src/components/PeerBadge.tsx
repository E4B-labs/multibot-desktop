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
import { Fragment, type CSSProperties } from "react";
import { useStore } from "@/state/store";
import { useLanguage } from "@/lib/language";
import { BOT_COLORS, normalizeState, type BotColor } from "@/lib/mascot";
import { splitMentions } from "@/lib/mentions";
import { botDisplayName } from "@/lib/botNames";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";

type ChipBot = ReturnType<typeof useStore>["state"]["bots"][number];

/**
 * multibot K2: JEDEN przepis na kolor pigułki bota, dla wszystkich jej dróg —
 * wzmianki w markdownie bota, dymku użytkownika, plakietki nadawcy i warstwy
 * podświetlenia w composerze.
 *
 * `bot.color` to NAZWA z allowlisty, nie kolor CSS — bez `BOT_COLORS` tło
 * brałoby słowo kluczowe CSS (`green` = #008000). `--bot-ink` to kolor bota
 * dociągnięty w połowie do atramentu skórki (#170): sam hex tonie i na jasnych
 * skórkach (yellow, white), i na ciemnych (black).
 *
 * Bez koloru (nazwa z koperty po skasowanym bocie) atramentem jest drugi plan
 * skórki — zielony domyślny kolor cudzego bota kłamałby o tożsamości.
 */
export function botChipStyle(color?: BotColor): CSSProperties {
  return {
    "--bot": color ? BOT_COLORS[color] ?? BOT_COLORS.green : "var(--color-ink-secondary)",
    "--bot-ink": "color-mix(in oklab, var(--bot) 50%, var(--color-ink))",
  } as CSSProperties;
}

// Wypełnienie 18% jak w plakietce bot↔bot z #170. Zmierzone dla 14 kolorów
// × 4 skórki na tle `--color-app`: najgorsza para white/lagoon 3,31:1, żadna
// poniżej 3,0. Obwódka `--bot-ink` odcina pigułkę od dymka.
export const BOT_CHIP_CLASS =
  "inline-flex translate-y-px items-center gap-1 rounded-full px-2 py-0.5 align-middle text-[13px] font-medium text-[var(--bot-ink)] [box-shadow:0_0_0_1px_var(--bot-ink)] bg-[color-mix(in_oklab,var(--bot)_18%,var(--color-app))]";

/** Bot znany aplikacji: awatar (własne zdjęcie, gdy jest) + nazwa wyświetlana.
 *  Bez małpki — owal z awatarem już mówi, że to bot, a „@" zostawiało dwa
 *  różne zapisy tej samej rzeczy. */
export function BotChip({ bot, className }: { bot: ChipBot; className?: string }) {
  const polish = useLanguage() === "pl";
  return (
    <span style={botChipStyle(bot.color)} className={cn(BOT_CHIP_CLASS, className)}>
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

/**
 * multibot K2: `@Imię` we WŁASNEJ wiadomości użytkownika. Trzecia droga do tej
 * samej pigułki: dymek użytkownika leci czystym tekstem (ChatView renderuje
 * markdown tylko dla bota), więc wtyczka wzmianek go nie widzi i nazwa
 * zostawała surowa. Bez tego chip z composera znikał w tej samej chwili, w
 * której użytkownik naciskał Enter.
 *
 * Ten sam tokenizer co w composerze i w markdownie bota — `splitMentions`.
 */
export function MentionText({ text }: { text: string }) {
  const { state } = useStore();
  const parts = splitMentions(text, state.bots);
  if (!parts.some((part) => part.name)) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) => {
        const bot = part.name
          ? state.bots.find((candidate) => candidate.name.toLowerCase() === part.name!.toLowerCase())
          : undefined;
        return bot ? <BotChip key={index} bot={bot} /> : <Fragment key={index}>{part.text}</Fragment>;
      })}
    </>
  );
}

/** Nadawca koperty bot→bot. Bywa botem, którego już nie ma — wtedy zostaje
 *  sama nazwa z koperty, bez awatara, zamiast pustego miejsca. */
export function PeerBadge({ name }: { name: string }) {
  const { state } = useStore();
  const bot = state.bots.find((b) => b.name.toLowerCase() === name.toLowerCase());
  if (!bot) return <span style={botChipStyle()} className={cn(BOT_CHIP_CLASS, "mr-1.5")}>{name}</span>;
  return <BotChip bot={bot} className="mr-1.5" />;
}
