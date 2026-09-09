// multibot: katalog marketplace'u jest tylko tak dobry, jak jego slugi.
// Slug spoza Composio wygląda w panelu normalnie, a „Dodaj" kończy się
// błędem z connect.composio.dev — czyli awaria widoczna dopiero po kliknięciu.
// Weryfikacja slugów: https://docs.composio.dev/toolkits/<slug> (sitemap
// tamtych docsów to pełna lista toolkitów).
import { describe, expect, it } from "vitest";
import { CURATED_SLUGS } from "./composio.ts";
import { APP_ICONS } from "../src/lib/appIcons.ts";

describe("curated catalog", () => {
  it("has no duplicates and only composio-shaped slugs", () => {
    expect(new Set(CURATED_SLUGS).size).toBe(CURATED_SLUGS.length);
    for (const slug of CURATED_SLUGS) expect(slug).toMatch(/^[a-z0-9][a-z0-9_]*$/);
  });

  it("drops the slugs Composio does not actually serve", () => {
    // Zapiera Composio nie ma w ogóle, a X-a wystawia jako `twitter`.
    expect(CURATED_SLUGS).not.toContain("zapier");
    expect(CURATED_SLUGS).not.toContain("x");
    expect(CURATED_SLUGS).toContain("twitter");
  });

  it("is big enough to be worth calling a marketplace", () => {
    expect(CURATED_SLUGS.length).toBeGreaterThan(60);
  });

  it("has a bundled brand mark for every app, no monogram fallbacks left", () => {
    // Monogram zostaje tylko dla własnych konektorów MCP użytkownika —
    // katalog kuratorowany ma komplet prawdziwych logotypów.
    expect(CURATED_SLUGS.filter((s) => !APP_ICONS[s])).toEqual([]);
  });
});
