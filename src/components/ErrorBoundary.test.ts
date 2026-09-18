import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

const Boom = () => {
  throw new Error("Minified React error #31");
};

/** Renderowanie po stronie serwera NIE zna granic błędu — `renderToStaticMarkup`
 * przepuszcza wyjątek dziecka na zewnątrz. Suita chodzi w środowisku `node`
 * (vite.config.ts) i nie ma tu DOM-u, więc dziecko rzuca naprawdę, a potem
 * przechodzimy dokładnie ten cykl życia, który w przeglądarce wykonuje React:
 * `getDerivedStateFromError` → ponowny render. */
function crash(): Error {
  try {
    renderToStaticMarkup(createElement(ErrorBoundary, null, createElement(Boom)));
  } catch (error) {
    return error as Error;
  }
  throw new Error("the throwing child did not throw");
}

describe("ErrorBoundary", () => {
  it("swaps a crashed child for a card that names the error", () => {
    const boundary = new ErrorBoundary({ children: createElement("p", null, "panel") });
    boundary.state = ErrorBoundary.getDerivedStateFromError(crash());
    const html = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Minified React error #31");
    expect(html).toContain("Reload panel");
  });

  it("puts the children back once the error is cleared", () => {
    const boundary = new ErrorBoundary({ children: createElement("p", null, "panel") });
    boundary.state = { error: null };
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toBe("<p>panel</p>");
  });

  it("is mounted where a crash would otherwise blank the app", () => {
    // Sam komponent nikogo nie ratuje, dopóki nie stoi nad panelami: raz nad
    // całym warsztatem, raz nad treścią zakładki ustawień (żeby szyna sekcji
    // przeżyła awarię Admina i dało się z niej wyjść klikiem).
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const settings = readFileSync(new URL("./AppSettingsPanel.tsx", import.meta.url), "utf8");
    expect(app).toContain("<ErrorBoundary>");
    expect(settings).toContain("<ErrorBoundary key={tab}>");
  });
});
