// multibot: JEDNO miejsce, które odróżnia „logowanie do CLI wygasło" od
// zwykłej awarii tury. Każdy driver (claude, codex, acp/opencode, grok…) pisze
// błąd własnymi słowami, więc dopasowanie jest opisowe, nie per-dostawca:
// nowy harness działa bez dopisywania tu czegokolwiek.
import { CLI_TOOLS } from "./cli-tools.ts";

/** Szum parsera: słowo „token" bez cienia logowania. Sprawdzany PRZED reszt
 * — inaczej „Invalid or unexpected token" z kompilatora udaje wygasłą sesję. */
const NOT_AUTH =
  /unexpected token|syntax ?error|tokeni[sz]|\btokens?\s*(used|count|limit|budget)\b|max_tokens|rate ?limit/i;

/** Fraza, która sama mówi „zaloguj się" — drugiego słowa nie potrzebuje. */
const SELF_CONTAINED =
  /\bunauthori[sz]ed\b|\bunauthenticated\b|\bnot (logged|signed) ?in\b|\bplease (log|sign) ?in\b|\b(log ?in|login|sign ?in|signin|authentication|authorization|authorisation) required\b|\bnot authenticated\b|\bre-?authenticate\b/i;

/** O czym mowa: uwierzytelnianie, a nie dowolny stan świata. */
const CONTEXT =
  /\b(auth|authn|authenticat\w*|authoriz\w*|authoris\w*|oauth|credentials?|login|log ?in|logged ?in|sign ?in|signed ?in|api ?keys?|tokens?)\b/i;
/** Co się z nim stało. */
const STATE =
  /\b(expired?|expires|expiry|invalid|revoked|401|refreshed?|missing|required|rejected|failed)\b/i;

/** Narzędzia CLI rozpoznawane po nazwie w treści błędu. */
const TOOL_PATTERNS = CLI_TOOLS.map((tool) => ({ id: tool.id, re: new RegExp(`\\b${tool.id}\\b`, "i") }));

/**
 * Czy ten tekst mówi „człowiek musi się zalogować"? Zwraca `null`, gdy nie —
 * a przy trafieniu podaje narzędzie, jeśli samo się przedstawiło w treści
 * (`claude exited 1 …`). Wołający zna bota, więc brak `tool` nie boli.
 */
export function authFailure(text: string): { tool?: string } | null {
  if (!text) return null;
  if (NOT_AUTH.test(text)) return null;
  if (!(SELF_CONTAINED.test(text) || (CONTEXT.test(text) && STATE.test(text)))) return null;
  return { tool: TOOL_PATTERNS.find((tool) => tool.re.test(text))?.id };
}

/** Treść dla `needsAttention` — stała, bo powłoka rozpoznaje ją po prefiksie. */
export const LOGIN_EXPIRED_PREFIX = "Login expired for ";
export const loginExpiredNote = (tool: string) =>
  `${LOGIN_EXPIRED_PREFIX}${tool}. Refresh it in Settings → CLI tools.`;
