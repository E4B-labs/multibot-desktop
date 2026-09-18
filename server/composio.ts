// Composio — two clients in one file:
//  1) the Connect meta-MCP (connect.composio.dev) for connection state +
//     auth links, ported from agentcal src/composio.js
//  2) the v3 toolkits catalog (backend.composio.dev) for the plugin
//     marketplace — names, descriptions, logos. Works when the key is a
//     project API key; when it isn't, the caller falls back to the curated
//     catalog below (logos then resolve via favicon fallback client-side).
import type { AppConfig } from "./config.ts";

const CONNECT_URL = "https://connect.composio.dev/mcp";
const BACKEND_URL = "https://backend.composio.dev/api/v3";

function parseMcpResponse(text: string) {
  // Streamable-HTTP servers answer JSON or SSE (`data: {...}` lines).
  const line = text.startsWith("{")
    ? text
    : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  if (!line) throw new Error("empty MCP response");
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(msg.error.message || "MCP error");
  const content = msg.result?.content?.find((c: any) => c.type === "text")?.text;
  if (!content) return msg.result ?? null;
  try {
    return JSON.parse(content);
  } catch {
    return { text: content };
  }
}

export async function composioTool(cfg: AppConfig, name: string, args: unknown) {
  if (!cfg.composio?.key) {
    throw new Error('no Composio key configured — add {"composio":{"key":"ck_…"}} to ~/.multibot/config.json');
  }
  const res = await fetch(cfg.composio.url || CONNECT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-consumer-api-key": cfg.composio.key,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Composio MCP: HTTP ${res.status}`);
  return parseMcpResponse(await res.text());
}

export interface ConnectedAccountSummary { id: string; alias?: string; status: string }

/** Connection status per service slug, including every connected account. */
export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: slugs.map((name) => ({ name, action: "list" })),
  });
  const results = out?.data?.results ?? {};
  const status: Record<string, { connected: boolean; status: string; accounts: ConnectedAccountSummary[] }> = {};
  for (const slug of slugs) {
    const r = results[slug];
    const accounts: ConnectedAccountSummary[] = (r?.accounts ?? []).flatMap((account: any) => {
      const id = String(account.id ?? account.account_id ?? account.nanoid ?? "");
      return id ? [{ id, ...(account.alias ? { alias: String(account.alias) } : {}), status: String(account.status ?? "unknown") }] : [];
    });
    const active = accounts.some((a) => /active/i.test(a.status)) || /^active$/i.test(r?.status ?? "");
    status[slug] = { connected: active, status: r?.status ?? "unknown", accounts };
  }
  return status;
}

/** Disconnect a service: remove every connected account for the slug. */
export async function removeService(cfg: AppConfig, slug: string) {
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: [{ name: slug, action: "list" }],
  });
  const accounts = out?.data?.results?.[slug]?.accounts ?? [];
  const ids = accounts.map((a: any) => a.id ?? a.account_id ?? a.nanoid).filter(Boolean);
  for (const id of ids) {
    await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: slug, action: "remove", account_id: id }],
    });
  }
  return { removed: ids.length };
}

/** Mint a browser auth link for one service. Returns { url } or throws. */
export async function authorizeService(cfg: AppConfig, slug: string, alias?: string) {
  const cleanAlias = alias?.trim();
  if (cleanAlias && (cleanAlias.length > 64 || /[\u0000-\u001f\u007f]/.test(cleanAlias))) throw new Error("account alias must be printable and at most 64 characters");
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: [{ name: slug, action: "add", ...(cleanAlias ? { alias: cleanAlias } : {}) }],
  });
  // be liberal: any https URL mentioning composio/auth wins, else the first
  const raw = JSON.stringify(out);
  const urls = raw.match(/https:\/\/[^"\\\s]+/g) ?? [];
  const url = urls.find((u) => /composio|connect|auth/i.test(u)) ?? urls[0];
  if (!url) throw new Error(`Composio returned no auth link for ${slug}`);
  return { url };
}

/** Remove exactly one account after proving it belongs to requested toolkit. */
export async function removeAccount(cfg: AppConfig, slug: string, accountId: string) {
  const cleanId = accountId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(cleanId)) throw new Error("invalid account id");
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: slug, action: "list" }] });
  const accounts = out?.data?.results?.[slug]?.accounts ?? [];
  if (!accounts.some((account: any) => String(account.id ?? account.account_id ?? account.nanoid ?? "") === cleanId)) throw new Error("account not found for service");
  return composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", { toolkits: [{ name: slug, action: "remove", account_id: cleanId }] });
}

// ── marketplace catalog ────────────────────────────────────────────────
// Sekcje marketplace'u. Etykiety siedzą w UI (tłumaczenia), tu tylko
// identyfikatory i ich kolejność na lewej szynie.
// Jedna lista, typ z niej wyprowadzony — dwa źródła prawdy rozjeżdżają się
// po cichu, bo TypeScript nie ma jak sprawdzić, że są tą samą listą.
export const CATEGORY_IDS = ["google", "productivity", "developer", "communication", "design", "data-ai", "business", "other"] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  category: CategoryId;
}

// Curated fallback — what the marketplace shows without a Composio project
// API key, czyli w praktyce u każdego, kto klucza nie wpisał. Ikony biorą się
// z `src/lib/appIcons.ts` po slugu (bundle, zero żądań), więc karta wygląda
// tak samo na desktopie i na telefonie.
//
// KAŻDY slug tu musi być prawdziwym toolkitem Composio, bo inaczej „Dodaj"
// kończy się błędem z connect.composio.dev. Weryfikacja: slug występuje
// w https://docs.composio.dev/toolkits/<slug> (sitemap docs to pełna lista).
// Stąd `twitter`, nie `x`, i stąd brak Zapiera — Composio go nie ma wcale.
const CURATED: ToolkitCard[] = [
  // ── praca i pliki ──
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", logo: null, category: "google" },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", logo: null, category: "google" },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", logo: null, category: "google" },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", logo: null, category: "google" },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", logo: null, category: "google" },
  { slug: "googlebigquery", label: "BigQuery", blurb: "Query warehouse datasets", logo: null, category: "google" },
  { slug: "google_maps", label: "Google Maps", blurb: "Places, routes and geocoding", logo: null, category: "google" },
  { slug: "outlook", label: "Outlook", blurb: "Microsoft mail and calendar", logo: null, category: "productivity" },
  { slug: "microsoft_teams", label: "Microsoft Teams", blurb: "Messages and channels", logo: null, category: "productivity" },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", logo: null, category: "productivity" },
  { slug: "coda", label: "Coda", blurb: "Docs, tables and automations", logo: null, category: "productivity" },
  { slug: "confluence", label: "Confluence", blurb: "Wiki spaces and pages", logo: null, category: "productivity" },
  { slug: "todoist", label: "Todoist", blurb: "Tasks and projects", logo: null, category: "productivity" },
  { slug: "calendly", label: "Calendly", blurb: "Scheduling links and bookings", logo: null, category: "productivity" },
  { slug: "zoom", label: "Zoom", blurb: "Meetings and recordings", logo: null, category: "productivity" },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", logo: null, category: "productivity" },
  { slug: "box", label: "Box", blurb: "Files and folders", logo: null, category: "productivity" },
  // ── kod i produkcja ──
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", logo: null, category: "developer" },
  { slug: "gitlab", label: "GitLab", blurb: "Issues, merge requests, pipelines", logo: null, category: "developer" },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", logo: null, category: "developer" },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", logo: null, category: "developer" },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", logo: null, category: "developer" },
  { slug: "datadog", label: "Datadog", blurb: "Metrics, logs and monitors", logo: null, category: "developer" },
  { slug: "pagerduty", label: "PagerDuty", blurb: "Incidents and on-call", logo: null, category: "developer" },
  { slug: "supabase", label: "Supabase", blurb: "Postgres, auth and storage", logo: null, category: "developer" },
  { slug: "vercel", label: "Vercel", blurb: "Deployments and projects", logo: null, category: "developer" },
  // ── rozmowy i social ──
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", logo: null, category: "communication" },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", logo: null, category: "communication" },
  { slug: "twitter", label: "X (Twitter)", blurb: "Post and read on X", logo: null, category: "communication" },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", logo: null, category: "communication" },
  { slug: "linkedin", label: "LinkedIn", blurb: "Posts and company pages", logo: null, category: "communication" },
  { slug: "youtube", label: "YouTube", blurb: "Videos, playlists and stats", logo: null, category: "google" },
  { slug: "instagram", label: "Instagram", blurb: "Posts and insights", logo: null, category: "communication" },
  { slug: "facebook", label: "Facebook", blurb: "Pages and posts", logo: null, category: "communication" },
  { slug: "tiktok", label: "TikTok", blurb: "Videos and analytics", logo: null, category: "communication" },
  { slug: "spotify", label: "Spotify", blurb: "Playlists and playback", logo: null, category: "communication" },
  // ── biznes ──
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search and updates", logo: null, category: "business" },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", logo: null, category: "business" },
  { slug: "shopify", label: "Shopify", blurb: "Orders, products, customers", logo: null, category: "business" },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", logo: null, category: "business" },
  { slug: "mailchimp", label: "Mailchimp", blurb: "Campaigns and audiences", logo: null, category: "business" },
  { slug: "intercom", label: "Intercom", blurb: "Conversations and contacts", logo: null, category: "business" },
  { slug: "zendesk", label: "Zendesk", blurb: "Tickets and users", logo: null, category: "business" },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", logo: null, category: "productivity" },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", logo: null, category: "productivity" },
  { slug: "clickup", label: "ClickUp", blurb: "Tasks, docs and goals", logo: null, category: "productivity" },
  { slug: "monday", label: "monday.com", blurb: "Boards and items", logo: null, category: "productivity" },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", logo: null, category: "productivity" },
  { slug: "make", label: "Make", blurb: "Automate across 2,000+ apps", logo: null, category: "business" },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", logo: null, category: "data-ai" },
  { slug: "mixpanel", label: "Mixpanel", blurb: "Product analytics and funnels", logo: null, category: "data-ai" },
  { slug: "snowflake", label: "Snowflake", blurb: "Warehouse queries", logo: null, category: "data-ai" },
  { slug: "contentful", label: "Contentful", blurb: "Content models and entries", logo: null, category: "design" },
  // ── projekt i web ──
  { slug: "figma", label: "Figma", blurb: "Files and comments", logo: null, category: "design" },
  { slug: "canva", label: "Canva", blurb: "Designs and folders", logo: null, category: "design" },
  { slug: "miro", label: "Miro", blurb: "Boards and widgets", logo: null, category: "design" },
  { slug: "webflow", label: "Webflow", blurb: "Sites, CMS and publishing", logo: null, category: "design" },
  { slug: "wordpress_com", label: "WordPress.com", blurb: "Posts, pages and media", logo: null, category: "design" },
  // ── AI ──
  { slug: "openai", label: "OpenAI", blurb: "Models, files and assistants", logo: null, category: "data-ai" },
  { slug: "gemini", label: "Gemini", blurb: "Google's multimodal models", logo: null, category: "google" },
  { slug: "perplexityai", label: "Perplexity", blurb: "Answers with citations", logo: null, category: "data-ai" },
  { slug: "openrouter", label: "OpenRouter", blurb: "One key, many models", logo: null, category: "data-ai" },
  { slug: "mistral_ai", label: "Mistral AI", blurb: "Open-weight and hosted models", logo: null, category: "data-ai" },
  { slug: "groqcloud", label: "Groq", blurb: "Very fast model inference", logo: null, category: "data-ai" },
  { slug: "hugging_face", label: "Hugging Face", blurb: "Models, datasets and spaces", logo: null, category: "data-ai" },
  { slug: "replicate", label: "Replicate", blurb: "Run and fine-tune models", logo: null, category: "data-ai" },
  { slug: "elevenlabs", label: "ElevenLabs", blurb: "Text to speech and voices", logo: null, category: "design" },
  { slug: "higgsfield_mcp", label: "Higgsfield", blurb: "Generate images, video and audio", logo: null, category: "design" },
  { slug: "runway", label: "Runway", blurb: "Generative video and editing", logo: null, category: "design" },
  { slug: "firecrawl", label: "Firecrawl", blurb: "Scrape and crawl to markdown", logo: null, category: "data-ai" },
  { slug: "exa", label: "Exa", blurb: "Neural web search for agents", logo: null, category: "data-ai" },
  { slug: "apify", label: "Apify", blurb: "Actors for scraping and automation", logo: null, category: "data-ai" },
];

let toolkitCache: { at: number; cards: ToolkitCard[] } | null = null;

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  if (toolkitCache && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  const backendKey = cfg.composio?.apiKey ?? cfg.composio?.key;
  if (backendKey) {
    try {
      const res = await fetch(`${BACKEND_URL}/toolkits?limit=500&sort_by=usage`, {
        headers: { "x-api-key": backendKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json: any = await res.json();
        const items = json.items ?? json.data ?? [];
        if (Array.isArray(items) && items.length) {
          const cards: ToolkitCard[] = items.map((t: any) => ({
            slug: (t.slug ?? t.key ?? t.name ?? "").toLowerCase(),
            label: t.name ?? t.slug ?? "",
            blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
            logo: t.meta?.logo ?? t.logo ?? null,
            category: categoryForToolkit(
              (t.slug ?? t.key ?? t.name ?? "").toLowerCase(),
              t.meta?.categories ?? t.categories ?? t.meta?.category ?? t.category,
            ),
          }));
          toolkitCache = { at: Date.now(), cards };
          return { cards, source: "api" };
        }
      }
    } catch {
      /* fall through to curated */
    }
  }
  return { cards: CURATED, source: "curated" };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
export const CURATED_CARDS: readonly ToolkitCard[] = CURATED;

// Mapa, nie goły obiekt: katalog może przyjść z API Composio, a slug
// `constructor` trafiłby w prototyp i zwrócił funkcję zamiast kategorii.
const CATEGORY_BY_SLUG = new Map(CURATED.map((c) => [c.slug, c.category] as const));

/** Kategoria sluga; `other` dla wszystkiego spoza kuratorowanego katalogu. */
export function categoryFor(slug: string): CategoryId {
  return CATEGORY_BY_SLUG.get(slug) ?? "other";
}

// ponytail: dopasowanie po słowach kluczowych, nie tabela 500 pozycji.
// Z kluczem API katalog Composio ma ~500 toolkitów, z czego kuratorowana lista
// zna 72 — bez tego cała reszta wpadała do „Inne" i szyna kategorii była pusta
// dokładnie na skonfigurowanej ścieżce. Composio wozi własne kategorie
// (`meta.categories[].name`), ale ich nazewnictwo jest jego, nie nasze, więc
// mapujemy je na nasze kubełki. Jeśli kiedyś zacznie zwracać stabilne id,
// zastąpić to mapą id→id, nie rozbudowywać regeksów.
const CATEGORY_KEYWORDS: [RegExp, CategoryId][] = [
  [/\bcrm\b|sales|marketing|commerce|payment|billing|invoic|support|helpdesk|ticket|finance|account|hr\b|recruit/i, "business"],
  [/developer|\bcode\b|coding|version.?control|\bci\b|\bcd\b|devops|infrastructur|monitor|observab|error|deploy|hosting|issue.?track/i, "developer"],
  [/communicat|messaging|\bchat\b|social|email|\bsms\b|voice|community/i, "communication"],
  [/design|media|video|image|photo|audio|music|\bcms\b|content.?management|publish|website.?builder/i, "design"],
  [/\bai\b|\bml\b|machine.?learning|\bllm\b|model|data\b|analytic|search|database|warehouse|scrap|crawl/i, "data-ai"],
  [/productiv|document|\bfile\b|storage|calendar|schedul|note|task|project.?manage|meeting|spreadsheet|knowledge/i, "productivity"],
];

/** Kategoria dla karty z API Composio: najpierw nasza lista, potem kategorie
 * zwrócone przez Composio po słowach kluczowych, na końcu `other`. */
export function categoryForToolkit(slug: string, categories: unknown): CategoryId {
  const known = CATEGORY_BY_SLUG.get(slug);
  if (known) return known;
  if (/^google/.test(slug)) return "google";
  const names = (Array.isArray(categories) ? categories : [])
    .map((c) => (typeof c === "string" ? c : String((c as { name?: unknown; slug?: unknown })?.name ?? (c as { slug?: unknown })?.slug ?? "")))
    .join(" ");
  if (!names.trim()) return "other";
  for (const [pattern, id] of CATEGORY_KEYWORDS) if (pattern.test(names)) return id;
  return "other";
}
