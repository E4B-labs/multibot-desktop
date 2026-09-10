// multibot: JEDNO miejsce, które odróżnia „logowanie do CLI wygasło" od
// zwykłej awarii tury. Każdy driver (claude, codex, acp/opencode, grok…) pisze
// błąd własnymi słowami, więc dopasowanie jest opisowe, nie per-dostawca:
// nowy harness działa bez dopisywania tu czegokolwiek.
import { CLI_TOOLS } from "./cli-tools.ts";

/** Nie NASZE logowanie, choć brzmi jak ono: driver dokleja ogon stderr, a tam
 * lądują odmowy gita, MCP i npm. Sesja CLI jest wtedy zdrowa — banerka
 * „zaloguj się ponownie" wysłałaby człowieka w złe miejsce. Sprawdzane PRZED
 * regułami, razem z szumem parsera („token" bez cienia logowania). */
const NOT_AUTH =
  /\bmcp\b|\bgit\b|github\.com|gitlab|bitbucket|\bnpm\b|registry\.|\bssh\b|unexpected token|syntax ?error|tokeni[sz]|\btokens?\s*(used|count|limit|budget)\b|max_tokens|rate ?limit/i;

/** Fraza, która sama mówi „zaloguj się" — drugiego słowa nie potrzebuje.
 * `auth\w*error` bez granicy z przodu łapie klasy błędów ACP, które driver
 * przepisuje dosłownie: `AuthError`, `ProviderAuthError`. */
const SELF_CONTAINED =
  /\bunauthori[sz]ed\b|\bunauthenticated\b|\bnot (logged|signed) ?in\b|\bplease (log|sign) ?in\b|\b(log ?in|login|sign ?in|signin|authentication|authorization|authorisation) required\b|\bnot authenticated\b|\bre-?authenticate\b|auth\w*error/i;

/** O czym mowa: uwierzytelnianie, a nie dowolny stan świata. Samo „token"
 * odpada — w tekście kompilatora i licznika zużycia znaczy co innego. */
const CONTEXT =
  "(?:auth|authn|authenticat\\w*|authoriz\\w*|authoris\\w*|oauth|credentials?|login|log ?in|logged ?in|sign ?in|signed ?in|api ?keys?|subscriptions?|(?:access|refresh|bearer|auth|api|id|session)[- ]?tokens?)";
/** Co się z nim stało. */
const STATE = "(?:expired?|expires|expiry|invalid|revoked|401|refreshed?|missing|required|rejected|failed)";
/** Oba słowa muszą stać BLISKO siebie (do trzech słów przerwy, w dowolnej
 * kolejności). Bez tego „Failed to load config" plus dowolne „auth" gdzieś
 * indziej w ogonie stderr wyglądało jak wygasła sesja. */
const NEAR = new RegExp(
  `(?:\\b${CONTEXT}\\b\\W+(?:\\w+\\W+){0,3}\\b${STATE}\\b|\\b${STATE}\\b\\W+(?:\\w+\\W+){0,3}\\b${CONTEXT}\\b)`,
  "i",
);

/** Narzędzia CLI rozpoznawane po nazwie w treści błędu. */
const TOOL_PATTERNS = CLI_TOOLS.map((tool) => ({ id: tool.id, re: new RegExp(`\\b${tool.id}\\b`, "i") }));

/**
 * Czy ten tekst mówi „człowiek musi się zalogować"? Zwraca `null`, gdy nie —
 * a przy trafieniu podaje narzędzie, jeśli samo się przedstawiło w treści
 * (`claude exited 1 …`). To tylko podpowiedź: pierwszeństwo ma harness, na
 * którym stoi bot (`cliToolIdFor`).
 */
export function authFailure(text: string): { tool?: string } | null {
  if (!text) return null;
  if (NOT_AUTH.test(text)) return null;
  if (!SELF_CONTAINED.test(text) && !NEAR.test(text)) return null;
  return { tool: TOOL_PATTERNS.find((tool) => tool.re.test(text))?.id };
}

/** multibot: który harness CLI napędza tego bota. `instanceId` bota jest
 * tożsame z `CLI_TOOLS[].id`, więc dopasowanie to samo sprawdzenie obecności
 * na liście — bot na własnym modelu HTTP nie ma żadnego logowania do
 * odświeżenia i dostaje `null`. */
export function cliToolIdFor(bot: { modelSelection?: { instanceId?: string } }): string | null {
  const id = bot.modelSelection?.instanceId;
  return id && CLI_TOOLS.some((tool) => tool.id === id) ? id : null;
}

/** Treść dla `needsAttention` — stała i angielska, bo powłoka rozpoznaje ją po
 * prefiksie i sama pisze zdanie w języku interfejsu. */
export const LOGIN_EXPIRED_PREFIX = "Login expired for ";
export const loginExpiredNote = (tool: string) => `${LOGIN_EXPIRED_PREFIX}${tool}. Sign in again to continue.`;
