import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

// multibot: jeden znak wczytywania na cały interfejs. Gdyby panel wrócił do
// własnego Loader2 albo do pustki, użytkownik znów nie wie, czy coś się dzieje.
describe("wspólny znak wczytywania", () => {
  it("Loading.tsx daje trzy prymitywy", () => {
    const source = read("Loading.tsx");
    for (const name of ["export function Spinner", "export function LoadingRow", "export function Skeleton"]) {
      expect(source).toContain(name);
    }
    expect(source).toContain("animate-spin");
    expect(source).toContain("animate-pulse");
  });

  it("kluczowe panele biorą go stąd, a nie z własnej kopii", () => {
    for (const file of ["Sidebar.tsx", "ChatView.tsx", "Composer.tsx", "CmdK.tsx", "AdminPanel.tsx"]) {
      expect(read(file)).toMatch(/from "\.\/Loading"/);
    }
  });

  it("paleta nie kłamie „brak wyników”, kiedy szuka", () => {
    const source = read("CmdK.tsx");
    expect(source).toContain("searching");
    expect(source.indexOf("searching")).toBeLessThan(source.indexOf("No results"));
  });

  // multibot: pracujacego bota pokazuje TYLKO pasek maskotki nad composerem.
  // Bombelek z kropkami w transkrypcie byl drugim, zbednym sygnalem.
  it("czat nie dubluje sygnalu pracy bombelkiem z kropkami", () => {
    expect(read("ChatView.tsx")).not.toContain("TypingBubble");
  });
});
