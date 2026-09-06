import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

// Panel „Server & devices" został usunięty z UI razem ze stanem otwierania.
describe("usunięty panel Server & devices", () => {
  it("nie renderuje panelu ani nie importuje jego komponentu", () => {
    expect(app).not.toContain("ServerAccessPanel");
    expect(app).not.toContain("serverAccessOpen");
  });
});

// 0.4.0: logowanie NIE jest już osobnym ekranem obok onboardingu. Były dwa
// wejścia w to samo (`LoginScreen` z pięcioma trybami i kreator z bramką
// e-mail), więc świeża instalacja potrafiła zobaczyć oba naraz. Zostaje jedno:
// `Onboarding` jest pierwszym ekranem i to on loguje.
describe("jedno wejście: Onboarding zamiast LoginScreen", () => {
  it("nie ma już drugiego ekranu logowania", () => {
    expect(app).not.toContain("LoginScreen");
    expect(app).not.toContain("loginTitle");
    expect(app).not.toContain("loginSwitch");
  });

  it("nie ma bramki e-mail ani starego tokenu jako dowodu konfiguracji", () => {
    expect(app).not.toContain("emailGateDone");
    expect(app).not.toContain("gated");
    expect(app).not.toContain("auth.token");
    expect(app).not.toContain("legacy");
  });

  it("render to dokładnie: powłoka po zalogowaniu, onboarding przed", () => {
    expect(app).toContain("if (!authenticated) return <Onboarding onDone={() => setAuthenticated(true)} />;");
  });
});
