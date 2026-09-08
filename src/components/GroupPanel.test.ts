import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: grupa ma być zwykłym czatem — jedna wiadomość do wszystkich,
// serwer wybiera, kto odpowiada. Panel z polami „zadanie na bota" i
// przyciskiem uruchamiania to była poprzednia, odrzucona wersja; test pilnuje,
// żeby nie wróciła. Vitest chodzi tu w środowisku node (repo nie ma jsdom),
// więc sprawdzamy źródło, wzorem `WindowControls.test.ts`.
const panel = readFileSync(new URL("./GroupPanel.tsx", import.meta.url), "utf8");
const members = readFileSync(new URL("./GroupMembersPanel.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

describe("GroupPanel", () => {
  it("nie ma już panelu zadań ani przycisku uruchamiania", () => {
    for (const gone of ["Bot tasks", "Zadania botów", "Run tasks", "Uruchom zadania", "buildGroupTasks", "<textarea"]) {
      expect(panel).not.toContain(gone);
    }
  });

  it("jest czatem: lista wiadomości plus Composer", () => {
    expect(panel).toContain('import { Composer } from "./Composer"');
    expect(panel).toContain("<Composer bot={answering} onSend={send} />");
    expect(panel).toContain("This group has no bots left.");
    expect(panel).toContain("/chat");
  });

  it("awatary w grupie są statyczne", () => {
    for (const source of [panel, members]) {
      const tags = source.match(/<MausAvatar[^>]*>/gs) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toContain("animated={false}");
    }
  });

  it("używa jednej spokojnej twarzy referencyjnej we wszystkich avatarach grupy", () => {
    for (const source of [panel, members]) {
      expect(source).toContain("GROUP_AVATAR_STATE");
      expect(source).toContain('shape="blob"');
      expect(source).not.toContain("avatarUrl=");
      expect(source).not.toContain("stateForBot(");
    }
  });
});

describe("GroupMembersPanel", () => {
  it("ma nagłówek Członkowie, podpowiedź i przycisk rutyny", () => {
    expect(members).toContain("Członkowie");
    expect(members).toContain("Members");
    expect(members).toContain("Utwórz więcej Botów, aby dodać je tutaj.");
    expect(members).toContain("Create more Bots to add them here.");
    expect(members).toContain("Rutyny to powtarzalne zadania, które ten Bot uruchamia zgodnie z harmonogramem.");
    expect(members).toContain("Utwórz rutynę");
  });
});

describe("wiersz grupy w Sidebarze", () => {
  it("układa awatary w skos i zastępuje przedni kółkiem +N", () => {
    const start = sidebar.indexOf("groupAvatarStack(members");
    const end = sidebar.indexOf("function GroupCreateForm", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const row = sidebar.slice(start, end);
    // kafelek 48 px jak awatar bota, tylny mniejszy w lewym górnym rogu
    expect(row).toContain("relative size-12 shrink-0");
    expect(row).toContain("absolute left-0 top-0");
    expect(row).toContain("size={28}");
    // przedni w prawym dolnym rogu, z obwódką w kolorze tła wiersza
    expect(row).toContain("absolute bottom-0 right-0");
    expect(row).toContain("ring-2 ring-panel");
    expect(row).toContain("+{plus}");
    // sidebarAvatarProps (pod aliasem groupMemberAvatarProps) zwraca animated:false
    expect(row).toContain("{...groupMemberAvatarProps(shown[0])}");
  });
});
