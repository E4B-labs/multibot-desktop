import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MOTION, bodyTransform, type BlobState } from "./BlobAvatar";

// multibot: „max 1 animowany bot, wszedzie". `BotAvatar` domyslnie ma
// `animated=true` (Avatar.tsx), wiec KAZDE nowe uzycie zaczyna mrugac i
// oddychac samo z siebie — tak wrocily animacje w karcie hovera sidebaru,
// w panelu ustawien bota i w onboardingu. Jedyne animowane wystapienie ma byc
// to na pasku nad composerem.
//
// Vitest chodzi w node bez jsdom, wiec czytamy zrodla: kazdy tag <BotAvatar
// poza Composerem musi jawnie wylaczyc animacje — wprost `animated={false}`
// albo przez propsy z `sidebarAvatarProps`, ktore zwraca `animated: false`
// dla kazdego bota (pilnuje tego Sidebar.test.ts).
const dir = fileURLToPath(new URL(".", import.meta.url));

/** Wylaczona animacja: wprost, przez propsy helpera albo przez jego spread. */
const STILL = /animated=\{(false|[\w.]+\.animated)\}|\{\.\.\.(sidebarAvatarProps|groupMemberAvatarProps)\(/;

/** Kazdy tag <BotAvatar ...> z pliku, razem z jego propsami. */
function avatarTags(source: string): string[] {
  const out: string[] = [];
  // `<BotAvatar` z przylepiona litera to typ (`<BotAvatarHandle>`), nie tag.
  for (const match of source.matchAll(/<BotAvatar(?![A-Za-z])[^>]*>/g)) out.push(match[0]);
  return out;
}

describe("maskotka poza paskiem nad composerem", () => {
  const files = readdirSync(dir).filter((name) => name.endsWith(".tsx") && name !== "Composer.tsx");

  it.each(files)("%s rysuje maskotki nieruchomo", (name) => {
    for (const tag of avatarTags(readFileSync(`${dir}${name}`, "utf8"))) {
      expect(tag, `${name}: ${tag}`).toMatch(STILL);
    }
  });

  it("pilnuje plikow, ktore faktycznie rysuja maskotke", () => {
    const drawing = files.filter((name) => avatarTags(readFileSync(`${dir}${name}`, "utf8")).length);
    expect(drawing).toContain("Sidebar.tsx");
    expect(drawing).toContain("SettingsPanel.tsx");
    expect(drawing).toContain("Onboarding.tsx");
  });
});

// multibot: zamrozony (paused) awatar ma miec proporcje ksztaltu bazowego.
// Regresja: sciezka paused rysowala JEDNA klatke z `performance.now()` jako
// faza ruchu, wiec stany ze `squash` (np. "happy" w SettingsPanel) potrafily
// zamarznac splaszczone (niejednorodna skala sx≠sy).
describe("paused render bez squasha", () => {
  it("bodyTransform przy zerowej sile ruchu nie daje zadnego transformu", () => {
    for (const state of Object.keys(MOTION) as BlobState[]) {
      // Kilka faz zegara — kazda musi dac neutralna poze.
      for (const elapsed of [0, 137, 820 / 4 + 5, 12345.6]) {
        expect(bodyTransform(MOTION[state] ?? {}, elapsed, 0), `${state}@${elapsed}`).toBe("");
      }
    }
  });

  it("squash naprawde istnieje przy pelnej sile (test pilnuje sam siebie)", () => {
    // "happy" ma bob+squash; w dolnej fazie luku transform zawiera scale(sx sy), sx≠sy.
    const t = bodyTransform(MOTION.happy, 820 * 0.75, 1);
    const m = /scale\(([\d.]+) ([\d.]+)\)/.exec(t);
    expect(m, t).not.toBeNull();
    expect(m![1]).not.toBe(m![2]);
  });

  it("sciezka paused w BlobAvatar rysuje cialo z sila 0", () => {
    const source = readFileSync(`${dir}BlobAvatar.tsx`, "utf8");
    expect(source).toMatch(/p\.paused \? 0 : p\.motionStrength \?\? 1/);
  });
});
