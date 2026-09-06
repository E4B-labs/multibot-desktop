import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootstrapLocalAuthToken } from "./lib/auth";
import "./styles.css";
import { applySkin, readSkin } from "./lib/skins";
import { applyMotionMode, readMotionMode } from "./lib/motion";

bootstrapLocalAuthToken();
applySkin(readSkin());
applyMotionMode(readMotionMode());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// multibot: G5 — cache only application shell/static assets. API and SSE stay network-only.
//
// Rejestracja MA PRAWO nie wyjść i to nie jest błąd aplikacji: przeglądarka
// odmawia service workera na originie z certyfikatem, któremu nie ufa
// (a od 0.4.0 serwer ma certyfikat z własnym podpisem — dopóki użytkownik go
// nie zaakceptuje, `register` odrzuca obietnicę). Bez tego `catch` leciał
// unhandled rejection w konsoli, a aplikacja i tak działa — tylko bez offline.
if (!import.meta.url.includes("/src/") && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((error) => {
      console.info("[multibot] offline cache off (service worker not registered):", error);
    });
  });
}
