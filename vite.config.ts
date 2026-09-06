import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "node",
    // multibot: electron/ ma własne testy node:test (remote-ui, updater) —
    // do vitest wchodzą tylko nowe moduły desktopowe pisane pod ten runner
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "electron/single-instance.test.mjs", "electron/window-state.test.mjs", "electron/diagnostics.test.mjs", "electron/host-resolve.test.mjs", "electron/tls-pin.test.mjs", "electron/host-probe.test.mjs", "electron/setup-values.test.mjs", "electron/notifications.test.mjs"],
    setupFiles: ["server/testing/setup.ts"],
    // Suita stawia PRAWDZIWY harness, a ten od 0.4.0 słucha po HTTPS z
    // certyfikatem z własnego podpisu. Testy są klientem tego certyfikatu —
    // nie ma tu CA do zapytania, więc weryfikacja łańcucha idzie w dół dla
    // całego procesu testowego (i dla procesów, które on forkuje).
    env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: [
        "**/release/**",
        "**/build/**",
        "**/dist/**",
        "**/electron/resources/**",
      ],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        // Harness słucha po HTTPS (self-signed) — `secure: false` wyłącza
        // sprawdzanie łańcucha dla samego dev-proxy, nie dla przeglądarki.
        target: `https://127.0.0.1:${process.env.OGB_PORT || 8799}`,
        secure: false,
        // multibot: harness ma własny WebSocket — bez tego dev-serwer nie
        // przepuszcza upgrade'u i kanał eventów działa wyłącznie w apce pakowanej
        ws: true,
      },
    },
  },
});
