// multibot (A2): wyliczenie narzędzi, które tura faktycznie dostała — trafia do
// promptu systemowego każdego drivera CLI/API. Dziś bot dowiadywał się tylko, że
// MA komputer (akapit o komputerze), ale nie znał reszty oferty; a bot bez
// komputera nie dowiadywał się niczego. Tu prompt dostaje jeden spójny akapit:
// „tego dostałeś narzędzia, tego nie dostałeś i dlaczego".
//
// Listy są statyczne — mirror z dwóch miejsc, żeby nie importować spawnerów
// (agents-proxy.ts to skrypt z runem, nie moduł):
//   - AGENTS_MCP_TOOLS  = TOOLS w server/drivers/agents-proxy.ts (28 narzędzi)
//   - COMPUTER_MCP_TOOLS = TOOLS w server/computer/mcp.ts (12 narzędzi)
//
// Że obie listy zgadzają się ze swoimi serwerami, pilnują testy — dla komputera
// `server/computer/computer.test.ts`. Serwer komputera jechał kiedyś przez
// silnik Hermesa i zniknął razem z nim; wrócił jako proxy stdio w harnessie.

/** Narzędzia serwera MCP komputera. */
export const COMPUTER_MCP_TOOLS = [
  "screenshot",
  "navigate",
  "read_page",
  "find",
  "click",
  "move",
  "type_text",
  "key",
  "scroll",
  "actions",
  "status",
  "computer_exec",
] as const;

/**
 * Wersja zestawu narzędzi serwera agents. **Podnieś przy KAŻDEJ zmianie
 * `AGENTS_MCP_TOOLS`.**
 *
 * Codex zapamiętuje w wątku listę narzędzi serwera, nie sam serwer, a
 * `thread/resume` jej nie odświeża. Bot, którego wątek powstał przed dodaniem
 * narzędzia, nie zobaczy go nigdy — i dokładnie tak zniknęło `send_file`:
 * doszło do listy, a istniejące boty odpowiadały „nie mam takiego narzędzia".
 * Ta liczba jedzie w kursorze wznowienia (`cursorMcpKey`), więc jej zmiana
 * zakłada nowy wątek i bot dostaje pełny zestaw.
 *
 * Cena: bot traci pamięć po stronie dostawcy. Transkrypt harnessu zostaje.
 */
export const AGENTS_TOOLS_VERSION = 12;

/** Narzędzia serwera agents — mirror `server/drivers/agents-proxy.ts` TOOLS. */
export const AGENTS_MCP_TOOLS = [
  "list_bots",
  "get_environment_snapshot",
  "ask_bot",
  "send_bot_mail",
  "read_bot_mail",
  "start_collab",
  "get_my_profile",
  "update_my_profile",
  "remember",
  "recall",
  "read_memory",
  "remember_for_team",
  "recall_team",
  "read_team_memory",
  "create_skill",
  "list_skills",
  "create_routine",
  "list_routines",
  "update_routine",
  "delete_routine",
  "run_routine",
  "create_reminder",
  "list_reminders",
  "delete_reminder",
  "notify_user",
  "request_connection",
  "create_agent",
  "get_agent",
  "update_agent",
  "delete_agent",
  "list_groups",
  "create_group",
  "delete_group",
  "send_group_message",
  "read_file",
  "write_file",
  "run_command",
  "get_device_info",
  "send_file",
  "ask_user",
  "hand_over_computer",
  "request_credential",
] as const;

export interface TurnIntegrationsLike {
  agents?: unknown;
  web?: unknown;
  webNative?: unknown;
  localComputer?: unknown;
  computer?: unknown;
  composio?: unknown;
}

/**
 * Nazwy połączeń zamontowanych W TEJ turze, każde ze swoimi narzędziami.
 * Generowane z `integrations` i ze stałych powyżej — nigdy wpisane na sztywno,
 * więc to, czego harness nie zamontował, nie ma prawa się tu pojawić. Używa
 * tego blok "Your connections and tools" w prompcie.
 */
export function mountedConnections(integrations: TurnIntegrationsLike | undefined): string[] {
  const out: string[] = [];
  if (integrations?.localComputer) out.push(`mcp__computer: ${COMPUTER_MCP_TOOLS.join(", ")}`);
  if (integrations?.computer) out.push("computer box: your cloud desktop");
  if (integrations?.agents) out.push(`agents: ${AGENTS_MCP_TOOLS.join(", ")}`);
  if (integrations?.web) out.push("web: web_search, web_extract");
  if (integrations?.webNative) out.push("web (native): web_search, web_extract");
  if (integrations?.composio) out.push("composio: your connected apps, found with COMPOSIO_SEARCH_TOOLS");
  return out;
}

/**
 * Markdown z wyliczeniem narzędzi tej tury. Pusty string tylko wtedy, gdy
 * integrations jest puste — a wtedy nie dodajemy do promptu żadnego akapitu
 * (bot po prostu działa na swoich natywnych narzędziach, jak w stockowym
 * MultiBot).
 */
export function turnToolsText(integrations: TurnIntegrationsLike | undefined): string {
  if (!integrations) return "";
  const lines: string[] = [];
  if (integrations.localComputer) {
    // Zadanie 1: bot ma wiedzieć że to JEGO komputer — trwały Linux z przeglądarką,
    // terminalem i plikami, jeden na workspace współdzielony przez wszystkie boty,
    // ale każdy ma do niego pełny dostęp. Opis musi być obok listy narzędzi, bo
    // sama lista nie mówi do czego służy.
    lines.push(
      `Your computer this turn — THIS IS YOUR COMPUTER: one persistent Linux desktop per workspace, shared by all bots but fully yours to use right now (browser, terminal and files are one environment). Computer MCP tools this turn (${COMPUTER_MCP_TOOLS.length}): ${COMPUTER_MCP_TOOLS.join(", ")} — browser: navigate/read_page/find/click/type_text/key/scroll/actions/move/screenshot/status, terminal: computer_exec, which runs a shell command INSIDE it (same filesystem and downloads the browser sees). Use them WITHOUT asking — this is your machine; never say you have no browser or terminal when these tools are listed.`,
    );
    // Kolejność pracy jest tu, a nie w opisach narzędzi, bo model wybiera ścieżkę
    // ZANIM przeczyta pierwszy docstring. Zmierzone: zrzut = ~0,4 s i ~1,7 tys.
    // tokenów obrazu, lista elementów = 3–6 ms i sam tekst.
    lines.push(
      "How to drive the computer cheaply: start with `read_page` (or `find`) — it returns a tree of interactive elements with refs like `[e12] button \"Log in\"`, and `click`/`type_text` take those refs, so you rarely need pixels. `screenshot` is the most expensive tool you have (~0.4 s and ~1.5-2k image tokens): take one only when you need the LAYOUT, or on a page with no text (PDF, canvas, map). Chain steps with `actions` instead of calling click/type_text/key one at a time — it runs them in one go and returns a fresh page snapshot; put any step that changes the page last, because the batch stops there. Anything you could do in a shell — download a file, check a URL, list a directory — is cheaper with `computer_exec` than by clicking.",
    );
  }
  if (integrations.web || integrations.webNative || integrations.agents) {
    if (integrations.web || integrations.webNative) {
      lines.push(
        "Web search and fetch this turn: `web_search(query)` searches the public web; `web_extract(url)` fetches and reads a URL; `fetch(url)` is an alias for `web_extract`. Use these tools for current information and never claim browsing is unavailable when they are listed.",
      );
    }
  }
  if (integrations.agents) {
    lines.push(
      `Agents/workspace MCP tools this turn (${AGENTS_MCP_TOOLS.length}): ${AGENTS_MCP_TOOLS.join(", ")}.`,
    );
    // `send_file` ginęło w liście dwudziestu czterech nazw. Bot, który ma
    // `write_file` i komputer, naturalnie zapisuje plik i podaje ścieżkę —
    // a użytkownik nie ma jak jej otworzyć z czatu. To zdanie jest jedynym
    // miejscem, w którym pada, że ścieżka nie jest dostarczeniem.
    lines.push(
      "When you produce a file for the user — a report, an export, an image, a document, any generated artifact — deliver it with `send_file`. A path on disk, a filename or a link is NOT delivery: the user cannot open it from the chat. Content you are WRITING YOURSELF goes straight into `send_file` as `content_base64` — do not save it to disk first, that only costs you an approval you do not need. Use `path` only for a file that already exists. Always set `mime` (`image/png`, `text/csv`, `text/html`…) or the chat cannot preview it. Never say a file is sent unless `send_file` returned success in this turn; if it failed, say so.",
    );
  }
  if (integrations.composio) {
    lines.push("Composio integration tools this turn: your connected apps (dynamic toolset).");
  }
  if (!lines.length) {
    lines.push(
      "No MCP tools are mounted this turn — work with the tools you have, say plainly what you cannot do, and ask the user when only they can help.",
    );
  }
  return lines.join("\n");
}
