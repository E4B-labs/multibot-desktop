// multibot: katalog marketplace'u jest tylko tak dobry, jak jego slugi.
// Slug spoza Composio wygląda w panelu normalnie, a „Dodaj" kończy się
// błędem z connect.composio.dev — czyli awaria widoczna dopiero po kliknięciu.
// Weryfikacja slugów: https://docs.composio.dev/toolkits/<slug> (sitemap
// tamtych docsów to pełna lista toolkitów).
import { describe, expect, it } from "vitest";
import { CATEGORY_IDS, CURATED_CARDS, CURATED_SLUGS, categoryFor, categoryForToolkit } from "./composio.ts";
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

describe("catalog categories", () => {
  it("puts every curated app in a known section", () => {
    for (const card of CURATED_CARDS) {
      expect(CATEGORY_IDS, `${card.slug} has category "${card.category}"`).toContain(card.category);
    }
  });

  it("leaves nothing curated in the catch-all", () => {
    // `other` jest tylko dla slugów przychodzących z API Composio — kartę
    // z naszej listy w tym worku zobaczyłby użytkownik jako sierotę.
    expect(CURATED_CARDS.filter((c) => c.category === "other").map((c) => c.slug)).toEqual([]);
  });

  it("fills every section, so the left rail has no empty entry", () => {
    for (const id of CATEGORY_IDS) {
      if (id === "other") continue;
      expect(CURATED_CARDS.some((c) => c.category === id), `section ${id} is empty`).toBe(true);
    }
  });

  it("falls back to other for a slug outside the catalog", () => {
    expect(categoryFor("definitely-not-a-toolkit")).toBe("other");
  });

  it("does not read the prototype for a slug like constructor", () => {
    // Katalog potrafi przyjść z API, więc slug nie musi być z naszej listy;
    // goły indeks obiektu zwróciłby tu funkcję zamiast kategorii.
    expect(categoryFor("constructor")).toBe("other");
    expect(categoryFor("toString")).toBe("other");
  });
});

describe("categories for toolkits coming from the Composio API", () => {
  it("prefers our own catalog over whatever the API says", () => {
    expect(categoryForToolkit("github", [{ name: "Productivity" }])).toBe("developer");
  });

  it("puts anything google-branded in the Google section", () => {
    expect(categoryForToolkit("googleadmin", undefined)).toBe("google");
  });

  it("maps Composio own categories onto our buckets", () => {
    // Z kluczem API katalog ma ~500 toolkitow, a nasza lista zna 72 — bez tego
    // cala reszta ladowala w „Inne" i szyna byla pusta.
    expect(categoryForToolkit("pipedrive", [{ name: "CRM" }])).toBe("business");
    expect(categoryForToolkit("bitbucket", [{ name: "Version Control" }])).toBe("developer");
    expect(categoryForToolkit("twilio", ["Communication"])).toBe("communication");
    expect(categoryForToolkit("cloudinary", [{ name: "Media & Design" }])).toBe("design");
    expect(categoryForToolkit("pinecone", [{ name: "Vector Database" }])).toBe("data-ai");
    expect(categoryForToolkit("evernote", [{ slug: "note-taking" }])).toBe("productivity");
  });

  it("falls back to other when the API says nothing useful", () => {
    expect(categoryForToolkit("whatever", undefined)).toBe("other");
    expect(categoryForToolkit("whatever", [])).toBe("other");
    expect(categoryForToolkit("whatever", [{ name: "Zzz" }])).toBe("other");
  });

  it("keeps every mapped id inside CATEGORY_IDS", () => {
    for (const name of ["CRM", "DevOps", "Chat", "Video", "Analytics", "Documents"]) {
      expect(CATEGORY_IDS).toContain(categoryForToolkit("x", [{ name }]));
    }
  });
});
