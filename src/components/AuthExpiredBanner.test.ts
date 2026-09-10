import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOGIN_EXPIRED_PREFIX, expiredLoginTool, peekCliLoginRequest, requestCliLogin, takeCliLoginRequest } from "@/lib/cliLogin";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// multibot: banerka i serwer rozmawiają JEDNYM polem (`needsAttention`) i jednym
// stałym prefiksem. Te testy pilnują, żeby żaden z trzech końców tej rury nie
// odjechał osobno: serwer pisze, banerka czyta, ustawienia otwierają logowanie.
describe("banerka wygasłego logowania", () => {
  it("czyta narzędzie z treści, którą pisze serwer", () => {
    expect(expiredLoginTool("Login expired for claude. Refresh it in Settings → CLI tools.")).toBe("claude");
    expect(expiredLoginTool("Login expired for opencode. Refresh it in Settings → CLI tools.")).toBe("opencode");
  });

  it("nie porywa innych powodów czekania", () => {
    expect(expiredLoginTool("Captcha przy logowaniu do Gmaila")).toBeNull();
    expect(expiredLoginTool(null)).toBeNull();
    expect(expiredLoginTool("")).toBeNull();
    expect(expiredLoginTool("Login expired for . brak nazwy")).toBeNull();
  });

  it("prefiks jest ten sam po obu stronach", () => {
    const server = read("../../server/auth-failure.ts");
    expect(server).toContain(`export const LOGIN_EXPIRED_PREFIX = "${LOGIN_EXPIRED_PREFIX}";`);
  });

  it("prośba o logowanie czeka na panel i znika po odebraniu", () => {
    expect(takeCliLoginRequest()).toBeNull();
    requestCliLogin("codex");
    expect(peekCliLoginRequest()).toBe("codex"); // wybór zakładki nie zużywa
    expect(takeCliLoginRequest()).toBe("codex");
    expect(takeCliLoginRequest()).toBeNull();
  });

  it("banerka stoi w czacie i prowadzi do ustawień", () => {
    const chat = read("./ChatView.tsx");
    expect(chat).toContain("<AuthExpiredBanner bot={bot} />");
    const banner = read("./AuthExpiredBanner.tsx");
    expect(banner).toContain("requestCliLogin(tool)");
    expect(banner).toContain(`dispatch({ type: "toggleAppSettings", open: true })`);
    // da się ją zamknąć bez naprawiania logowania
    expect(banner).toContain("setDismissed(attention)");
  });

  it("ustawienia otwierają zakładkę z listą CLI i same startują logowanie", () => {
    const panel = read("./AppSettingsPanel.tsx");
    expect(panel).toContain(`peekCliLoginRequest() ? "other" : "general"`);
    expect(panel).toContain("const requested = takeCliLoginRequest();");
    expect(panel).toContain("if (tool.loginAvailable) void startLogin(tool);");
    // narzędzie bez interaktywnego logowania dostaje komendę do skopiowania
    expect(panel).toContain("else setManualLogin(tool.id);");
    expect(panel).toContain("navigator.clipboard?.writeText(item.loginCommand ?? \"\")");
  });

  it("ramka z serwera ląduje w tym samym polu co reszta powodów czekania", () => {
    const store = read("../state/store.tsx");
    expect(store).toContain(`case "auth-expired":`);
    expect(store).toContain(`rawDispatch({ type: "botPatched", bot: { id: frame.botId, needsAttention: frame.message } });`);
  });
});
