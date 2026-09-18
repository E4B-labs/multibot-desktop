import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: skill wspomniany w wiadomości był czarną pigułką (SkillPill,
// bg-[#111]) wklejoną w środek zdania — Kacper: „nie ten zjebany format".
// Ma być TEKSTEM w kolorze skilli, z różdżką, opisem pod hoverem i wejściem
// w panel skilli. Vitest chodzi w node bez jsdom, więc pilnujemy źródeł.
const ref = readFileSync(new URL("./SkillRef.tsx", import.meta.url), "utf8");
const markdown = readFileSync(new URL("./ChatMarkdown.tsx", import.meta.url), "utf8");
const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./SkillsPanel.tsx", import.meta.url), "utf8");

describe("SkillRef", () => {
  it("jest tekstem w kolorze skilli, nie czarną pigułką", () => {
    expect(ref).toContain("text-[#ffb700]");
    expect(ref).not.toContain("bg-[#111]");
  });

  it("nie ma ramki ani tła — sama nazwa z różdżką", () => {
    // Kacper (screenshot 19:17): chip ma zostać ikoną i żółtym tekstem,
    // żółta obwódka/pigułka znika także w wariancie zdarzenia.
    expect(ref).not.toMatch(/border-\[#ffb700\]/);
    expect(ref.match(/className=\{cn\([\s\S]*?\)\}/)?.[0] ?? "").not.toContain("rounded-full");
  });

  it("ma ikonę różdżki przy nazwie", () => {
    expect(ref).toContain("<Wand2");
  });

  it("pokazuje opis pod hoverem i fokusem", () => {
    expect(ref).toContain("onMouseEnter");
    expect(ref).toContain("onFocus");
    expect(ref).toContain('role="tooltip"');
    expect(ref).toContain("state.skills.find");
  });

  it("klik otwiera panel skilli rozwinięty na tym skillu", () => {
    expect(ref).toContain('dispatch({ type: "toggleSkills", open: true, skill: name })');
    expect(panel).toContain("state.skillFocus");
  });
});

describe("SkillPill zniknął z całego czatu", () => {
  it("nie ma go ani w prozie, ani w pigułce zdarzenia, ani w panelu", () => {
    for (const [where, source] of [["ChatMarkdown", markdown], ["ChatView", chat], ["SkillsPanel", panel]] as const) {
      expect(source, where).not.toContain("SkillPill");
    }
    // SkillsPanel nie wymienia już skilla po nazwie w prozie (karta nagrywania
    // zniknęła razem z silnikiem), więc SkillRef zostaje tylko w czacie.
    for (const [where, source] of [["ChatMarkdown", markdown], ["ChatView", chat]] as const) {
      expect(source, where).toContain("SkillRef");
    }
  });
});
