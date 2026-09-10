// multibot: „logowanie do CLI wygasło" ma dwa końce w DWÓCH gałęziach drzewa —
// banerkę w czacie i panel ustawień (App.tsx rysuje albo jedno, albo drugie,
// nigdy oba). Prośbę przenosi więc zwykła zmienna modułu: żadnego kontekstu,
// żadnego zdarzenia okna, żadnego stanu w store.

/** Prefiks `needsAttention` pisany przez serwer (server/auth-failure.ts). */
export const LOGIN_EXPIRED_PREFIX = "Login expired for ";

/**
 * Które narzędzie CLI prosi o ponowne logowanie — `null`, gdy `needsAttention`
 * mówi o czymkolwiek innym (pytanie bota, captcha, cokolwiek).
 */
export function expiredLoginTool(attention: string | null | undefined): string | null {
  if (!attention || !attention.startsWith(LOGIN_EXPIRED_PREFIX)) return null;
  return /^([a-z0-9-]+)\./i.exec(attention.slice(LOGIN_EXPIRED_PREFIX.length))?.[1] ?? null;
}

let pending: string | null = null;

/** Banerka: „otwórz ustawienia i zaloguj TO narzędzie". */
export function requestCliLogin(toolId: string): void {
  pending = toolId;
}

/** Ekran ustawień: która zakładka ma się otworzyć. Nie zużywa prośby — robi to
 * dopiero lista narzędzi CLI, która żyje na zakładce „inne". */
export function peekCliLoginRequest(): string | null {
  return pending;
}

/** Panel ustawień przy montowaniu: odbiera prośbę i od razu ją zużywa. */
export function takeCliLoginRequest(): string | null {
  const id = pending;
  pending = null;
  return id;
}
