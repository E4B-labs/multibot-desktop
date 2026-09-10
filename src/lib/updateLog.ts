// multibot: historia zmian w Ustawieniach → Aktualizacje. Ten plik był
// początkowo kopią bajt w bajt swojego odpowiednika z repo mobilnego
// (`webui/src/lib/updateLog.ts` w `E4B-labs/multibot-mobile`) — gałąź mostu
// natywnego zostaje, bo `sync-webui.mjs` przenosi ten plik między repami, a w
// Electronie i tak nigdy się nie odpala (`isReactNativeShell()` → false, więc
// od razu leci zwykły `fetch`). RÓŻNICA DO NADROBIENIA PO TAMTEJ STRONIE:
// odczyt `x-ratelimit-reset` i walidacja `html_url` niżej powstały tutaj.
import { isReactNativeShell, shellPost } from "./shell";

export const COMMITS_PER_PAGE = 10;

/** Limit GitHuba dla zapytań bez tokenu to 60/h na adres IP i jest to
 *  najczęstsza porażka tego panelu — dlatego wyjątek niesie moment
 *  odblokowania, żeby dało się napisać „spróbuj po 14:20" zamiast „nie da
 *  się", po którym użytkownik klika Ponów w kółko. Most natywny nie przenosi
 *  nagłówków, więc na telefonie zostaje sam komunikat ogólny. */
export type UpdateLogError = Error & { retryAt?: number };

function unavailable(status: number, resetHeader?: string | null): UpdateLogError {
  const error: UpdateLogError = new Error(`Update log unavailable (${status}).`);
  const reset = Number(resetHeader);
  // 403 = limit bez tokenu, 429 = limit wtórny; oba niosą sekundy uniksowe.
  if ((status === 403 || status === 429) && Number.isFinite(reset) && reset > 0) error.retryAt = reset * 1000;
  return error;
}

export type UpdateLogEntry = {
  sha: string;
  shortSha: string;
  message: string;
  date: string;
  url: string;
};

export type UpdateLogPage = {
  page: number;
  hasNext: boolean;
  totalPages: number;
  entries: UpdateLogEntry[];
};

type NativeUpdateLogDetail = {
  requestId?: string;
  ok?: boolean;
  status?: number;
  body?: unknown;
  link?: string | null;
};

const NATIVE_UPDATE_LOG_EVENT = "mb:update-log";
const NATIVE_UPDATE_LOG_TIMEOUT_MS = 4_000;

type PageNumber = number | "…";

function safePage(page: number): number {
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function commitsUrl(repository: string, page: number): string {
  return `https://api.github.com/repos/${repository}/commits?sha=main&per_page=${COMMITS_PER_PAGE}&page=${safePage(page)}`;
}

function relatedPage(linkHeader: string | null, relation: "next" | "last"): number | null {
  const link = linkHeader?.split(",").find((part) => part.includes(`rel="${relation}"`));
  const match = link?.match(/[?&]page=(\d+)/);
  return match ? Number(match[1]) : null;
}

export function pageNumbers(currentPage: number, totalPages: number): PageNumber[] {
  const total = Math.max(1, Math.trunc(totalPages));
  const current = Math.min(Math.max(safePage(currentPage), 1), total);
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, "…", total];
  if (current >= total - 3) return [1, "…", total - 4, total - 3, total - 2, total - 1, total];
  return [1, "…", current - 1, current, current + 1, "…", total];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function parseEntry(value: unknown): UpdateLogEntry | null {
  const candidate = record(value);
  const commit = record(candidate?.commit);
  const author = record(commit?.author);
  const committer = record(commit?.committer);
  const sha = typeof candidate?.sha === "string" ? candidate.sha : "";
  // Adres trafia wprost do `href`, a odpowiedź jest cudza — bierzemy tylko to,
  // co naprawdę wskazuje na GitHuba, żeby podmienione pole nie stało się
  // linkiem do czegokolwiek innego.
  const html = typeof candidate?.html_url === "string" ? candidate.html_url : "";
  const url = html.startsWith("https://github.com/") ? html : "";
  const message = typeof commit?.message === "string" ? commit.message.split(/\r?\n/, 1)[0].trim() : "";
  const date = typeof author?.date === "string" ? author.date : typeof committer?.date === "string" ? committer.date : "";
  if (!sha || !url || !message || !date) return null;
  return { sha, shortSha: sha.slice(0, 7), message, date, url };
}

export function parseUpdateLogPage(value: unknown, page: number, linkHeader: string | null): UpdateLogPage {
  const current = safePage(page);
  const entries = Array.isArray(value) ? value.map(parseEntry).filter((entry): entry is UpdateLogEntry => entry !== null) : [];
  const next = relatedPage(linkHeader, "next");
  const last = relatedPage(linkHeader, "last");
  return {
    page: current,
    hasNext: next !== null,
    totalPages: Math.max(current, last ?? (next === null ? current : current + 1)),
    entries,
  };
}

/** Use the native shell on mobile so GitHub access does not depend on WebView CORS policy. */
async function fetchUpdateLogViaNative(
  repository: string,
  page: number,
  signal?: AbortSignal,
): Promise<UpdateLogPage | null> {
  if (!isReactNativeShell()) return null;
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

  return new Promise<UpdateLogPage | null>((resolve, reject) => {
    const requestId = `update-log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener(NATIVE_UPDATE_LOG_EVENT, onResult);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<NativeUpdateLogDetail>).detail;
      if (!detail || detail.requestId !== requestId) return;
      if (!detail.ok) {
        finish(() => reject(unavailable(detail.status ?? 0)));
        return;
      }
      finish(() => resolve(parseUpdateLogPage(detail.body, page, detail.link ?? null)));
    };
    const onAbort = () => finish(() => reject(new DOMException("The operation was aborted.", "AbortError")));
    const timeout = setTimeout(() => {
      shellPost({ type: "update-log.cancel", requestId });
      finish(() => resolve(null));
    }, NATIVE_UPDATE_LOG_TIMEOUT_MS);

    window.addEventListener(NATIVE_UPDATE_LOG_EVENT, onResult);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (!shellPost({ type: "update-log.request", requestId, repository, page })) {
      finish(() => resolve(null));
    }
  });
}

export async function fetchUpdateLog(repository: string, page: number, signal?: AbortSignal): Promise<UpdateLogPage> {
  const nativeResult = await fetchUpdateLogViaNative(repository, page, signal);
  if (nativeResult) return nativeResult;
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

  const response = await fetch(commitsUrl(repository, page), {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw unavailable(response.status, response.headers.get("x-ratelimit-reset"));
  return parseUpdateLogPage(await response.json(), page, response.headers.get("link"));
}
