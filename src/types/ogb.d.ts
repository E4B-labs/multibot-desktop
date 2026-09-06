// The narrow bridge the Electron preload exposes. Absent in the browser.
export {};

declare global {
  interface Window {
    /** Wstrzykiwane przez proxy trybu zdalnego (electron/remote-ui.mjs) do
     * `index.html`. Nieobecne wszędzie indziej: w przeglądarce i pod
     * Electronem z lokalnym serwerem. */
    __MULTIBOT_REMOTE__?: true;
    ogb?: {
      screenFrame(): Promise<string | null>;
      speechStart(): Promise<void>;
      speechStop(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null }) => void): () => void;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech. */
      permOpenSettings(pane: "mic" | "screen" | "speech"): Promise<void>;
      /** Saves a remote host and switches the shell to it (onboarding
       * "connect"). Optional — older shells don't expose it, so callers must
       * feature-detect and fall back to a plain navigation. */
      addRemoteHost?(url: string): Promise<void>;
      /** Returns to local host, restoring local onboarding when it is pending. */
      useLocalHost?(): Promise<void>;
      /** Asks the shell whether a MultiBot server answers at this address, and
       * whether it already has a name and password of its own. Native, because
       * the server sends no CORS headers and the webui is not in its origin
       * yet. Absent in the browser and in shells older than 0.4.0. */
      probeHost?(url: string): Promise<HostProbeResult>;
      /** Trades the server name + password for a short-lived join grant, saves
       * the host and switches the window to it with `#join=<grant>`. The
       * password never leaves the main process. */
      joinHost?(url: string, serverName: string, serverPassword: string): Promise<HostJoinResult>;
      /** Opens the native host picker WITHOUT changing the active host. */
      showHostPicker?(): Promise<void>;
      /** Unread-conversation count for the taskbar badge. Fire-and-forget;
       * absent in plain browsers, so callers must feature-detect. */
      setUnreadCount?(count: number): void;
      /** Banerka systemowa rysowana przez proces główny — kliknięcie potrafi
       * wtedy podnieść okno. Nieobecne w przeglądarce: tam renderer sięga po
       * zwykłe Notification, więc callers muszą sprawdzać obecność. */
      notify?(payload: { title: string; body: string; botId?: string }): void;
      /** Kliknięto banerkę należącą do bota — otwórz go. Zwraca odsubskrybowanie. */
      onNotificationClick?(cb: (botId: string) => void): () => void;
      exportDiagnostics?(): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
      /** Akceleracja sprzętowa; domyślnie wyłączona. Zmiana działa dopiero po
       * restarcie — Electron rozstrzyga to przed gotowością aplikacji.
       * Nieobecne w przeglądarce, więc callers muszą sprawdzać obecność. */
      hardwareAcceleration?: {
        get(): Promise<boolean>;
        set(enabled: boolean): Promise<boolean>;
        status?(): Promise<{
          enabled: boolean;
          active: boolean;
          compositing: string;
          rasterization: string;
        }>;
      };
      /** Własne kontrolki okna. Preload wystawia je tylko tam, gdzie ramka
       * systemowa jest zdjęta (Windows, Linux) — nieobecne pod macOS i w
       * przeglądarce, więc obecność tego pola jest sygnałem, że interfejs
       * ma narysować min/max/zamknij sam. */
      window?: {
        minimize(): void;
        toggleMaximize(): void;
        close(): void;
      };
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        /** currently installed app version */
        currentVersion(): Promise<string>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

/** `error` codes: transport ones are `unreachable` | `timeout` |
 * `not-multibot` | `certificate_changed` (a pinned certificate changed — see
 * electron/tls-pin.mjs) | `forbidden` (called from a page that isn't ours —
 * a screen served straight from the host joins same-origin instead). */
export type HostProbeResult =
  | { ok: true; configured: boolean; tlsFingerprint?: string }
  | { ok: false; error: string };

/** On failure `error` is the server's own code — `wrong_server_name`,
 * `wrong_server_password`, `server_not_set_up`, `rate_limited` — or one of the
 * transport codes above, so the form can point at the field at fault. */
export type HostJoinResult =
  | { ok: true; joinGrant: string; expiresAt?: number; hasUsers?: boolean }
  | { ok: false; error: string };

export interface UpdaterState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
}
