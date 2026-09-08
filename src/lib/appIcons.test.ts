// multibot: ikony katalogu wtyczek jadą z bundla, nie z sieci — bo na
// telefonie interfejs jest stringiem w paczce aplikacji i żaden obcy host
// nie ma jak się dociągnąć. Testy pilnują, że tak zostaje.
//
// Ten plik jedzie też do repo mobilnego (webui/src/lib), więc nie wolno mu
// sięgać do `server/` — asercje o samym katalogu siedzą w
// `server/composio.test.ts`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_ICONS } from "./appIcons";

const panel = readFileSync(new URL("../components/PluginsPanel.tsx", import.meta.url), "utf8");

describe("APP_ICONS", () => {
  it("holds drawable 24x24 path data", () => {
    expect(Object.keys(APP_ICONS).length).toBeGreaterThan(50);
    for (const [slug, d] of Object.entries(APP_ICONS)) {
      expect(slug, `${slug} must be a composio-shaped slug`).toMatch(/^[a-z0-9][a-z0-9_]*$/);
      expect(d.startsWith("M") || d.startsWith("m"), `${slug} path must start with a moveto`).toBe(true);
      expect(d.length, `${slug} path looks truncated`).toBeGreaterThan(20);
      expect(d).not.toContain('"');
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
