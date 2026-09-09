// multibot: ikony katalogu wtyczek jadą z bundla, nie z sieci — bo na
// telefonie interfejs jest stringiem w paczce aplikacji i żaden obcy host
// nie ma jak się dociągnąć. Testy pilnują, że tak zostaje, i że znak
// zachowuje WŁASNE kolory marki (żadnego `currentColor`, żadnego
// przemalowania w komponencie).
//
// Ten plik jedzie też do repo mobilnego (webui/src/lib), więc nie wolno mu
// sięgać do `server/` — asercje o samym katalogu siedzą w
// `server/composio.test.ts`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_ICONS } from "./appIcons";

const panel = readFileSync(new URL("../components/PluginsPanel.tsx", import.meta.url), "utf8");

describe("APP_ICONS", () => {
  it("holds a drawable inline svg per slug", () => {
    expect(Object.keys(APP_ICONS).length).toBeGreaterThan(70);
    for (const [slug, svg] of Object.entries(APP_ICONS)) {
      expect(slug, `${slug} must be a composio-shaped slug`).toMatch(/^[a-z0-9][a-z0-9_]*$/);
      expect(svg.startsWith("<svg "), `${slug} must be a full svg element`).toBe(true);
      expect(svg.endsWith("</svg>"), `${slug} must close its svg`).toBe(true);
      expect(svg, `${slug} needs a viewBox to scale into the tile`).toMatch(/viewBox="[-\d. ]+"/);
      expect(svg.length, `${slug} looks truncated`).toBeGreaterThan(60);
      // pojedynczy cudzysłów rozwaliłby literał w appIcons.ts
      expect(svg).not.toContain("'");
    }
  });

  it("paints every mark in its own brand colours", () => {
    for (const [slug, svg] of Object.entries(APP_ICONS)) {
      // `currentColor` dziedziczy kolor tekstu, czyli robi z loga
      // jednokolorową klaksę — dokładnie to, co ta zmiana usuwa.
      expect(svg, `${slug} must not inherit the text colour`).not.toMatch(/currentColor/i);
      // kolor bywa atrybutem (fill="#fff") albo deklaracją w style=
      // ("fill:url(#outlook0)") — Outlook wozi cały gradient w style
      expect(svg, `${slug} must name a colour of its own`).toMatch(
        /(?:fill|stop-color|stroke)\s*[:=]\s*"?(?:#|url\(|[a-z])/,
      );
    }
  });

  it("pulls nothing from a third-party host at runtime", () => {
    for (const [slug, svg] of Object.entries(APP_ICONS)) {
      // WebView na telefonie i tak by tego nie dociągnął; jedyny dozwolony
      // adres to namespace SVG, który niczego nie pobiera.
      const urls = (svg.match(/https?:\/\/[^"')\s]+/g) ?? []).filter((u) => u !== "http://www.w3.org/2000/svg");
      expect(urls, `${slug} must not reference ${urls.join(", ")}`).toEqual([]);
    }
  });

  it("namespaces every id so the whole catalog can share one document", () => {
    const owner = new Map<string, string>();
    for (const [slug, svg] of Object.entries(APP_ICONS)) {
      const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, `${slug} defines an id twice`).toBe(ids.length);
      for (const id of ids) {
        expect(owner.has(id), `id "${id}" is claimed by both ${owner.get(id)} and ${slug}`).toBe(false);
        owner.set(id, slug);
      }
      // gradient/mask wskazujący na nieistniejące id potrafi wygasić cały
      // element w starszym WebView
      for (const [, ref] of svg.matchAll(/(?:url\(#|href="#)([^)"]+)/g)) {
        expect(ids, `${slug} points at a missing #${ref}`).toContain(ref);
      }
    }
  });
});

describe("PluginsPanel", () => {
  it("fetches no icon from a third-party host", () => {
    // logo z katalogu Composio zostaje (adres przychodzi z API), ale nic tu
    // nie może wpisywać obcego hosta na sztywno — favicon z google.com wyleciał.
    expect(panel).not.toContain("google.com/s2/favicons");
    expect(panel.match(/src=\{?["'`]https?:/g)).toBeNull();
  });

  it("draws the bundled mark first and never leaves an empty tile", () => {
    expect(panel).toContain("APP_ICONS[card.slug]");
    // monogram to podkład pod <img>, nie gałąź else: zawieszone żądanie
    // nie odpala onError, a wtedy karta zostawała pusta
    expect(panel).toContain("absolute inset-0");
  });

  it("never recolours the brand mark", () => {
    const tile = panel.slice(panel.indexOf("const TILE"), panel.indexOf("function ServiceIcon"));
    // te klasy przemalowałyby pełnokolorowe logo na jeden kolor
    expect(tile).not.toMatch(/fill-current|fill-ink|\btext-ink\b/);
    // kafelek musi zostać jasny w KAŻDYM motywie, inaczej czarne marki
    // (GitHub, X, OpenAI, Vercel) znikają w ciemnym
    expect(tile).toContain("bg-white");
  });

  it("shows one flat All apps list, no Featured bucket", () => {
    expect(panel).not.toContain("FEATURED_SLUGS");
    expect(panel).not.toContain("ORCHESTRATION_HINTS");
    // etykieta sekcji, nie samo słowo — komentarz obok wyjaśnia, czemu jej nie ma
    expect(panel).not.toContain('"Wyróżnione"');
    expect(panel).toContain("Wszystkie aplikacje");
  });

  it("lets the dialog shrink to a phone screen", () => {
    expect(panel).toContain("w-full max-w-[640px]");
    expect(panel).toContain("grid-cols-1 gap-2 sm:grid-cols-2");
  });
});
