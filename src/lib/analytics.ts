// Optional PostHog usage analytics.
import posthog from "posthog-js";

const TOKEN = import.meta.env.VITE_POSTHOG_KEY ?? "";

let ready = false;

export function initAnalytics() {
  if (ready || !TOKEN) return;
  posthog.init(TOKEN, {
    api_host: "https://us.i.posthog.com",
    autocapture: true,
    capture_pageview: false,
    person_profiles: "identified_only",
    persistence: "localStorage",
  });
  ready = true;
  const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
  if (!localStorage.getItem("multibot-installed")) {
    localStorage.setItem("multibot-installed", new Date().toISOString());
    posthog.capture("app_first_open", { platform });
  }
  posthog.capture("app_opened", { platform });
}

export function track(event: string, props?: Record<string, unknown>) {
  if (!ready) return;
  posthog.capture(event, props);
}
