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
if (!import.meta.url.includes("/src/") && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }));
}
