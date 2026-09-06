// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer } = require("electron");

// multibot: ten sam warunek co CUSTOM_WINDOW_CHROME w main.mjs. Gdzie ramkę
// systemową zdjęliśmy, tam interfejs musi dostać własne min/max/close; na
// macOS pole zostaje nieobecne, więc React nie rysuje niczego zbędnego.
const customWindowChrome = process.platform !== "darwin";

contextBridge.exposeInMainWorld("ogb", {
  /** One frame of this Mac's screen as a data: URL (Screen Recording TCC). */
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  speechStart: () => ipcRenderer.invoke("speech:start"),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),

  /** Onboarding "connect": remember this remote host and switch to it, so the
   * next launch goes straight there instead of showing onboarding again. The
   * main process reloads this window, so the returned promise usually dies
   * with the page — that's expected. */
  addRemoteHost: (url) =>
    ipcRenderer.invoke("hosts:add-remote", { url }).then((host) => ipcRenderer.invoke("hosts:use-host", host.id)),
  useLocalHost: () => ipcRenderer.invoke("hosts:use-local"),

  /** Czy pod tym adresem stoi serwer MultiBota i czy jest już skonfigurowany.
   * Natywnie, bo przeglądarkowy fetch rozbiłby się o brak CORS. */
  probeHost: (url) => ipcRenderer.invoke("hosts:probe", url),
  /** Wymiana nazwy i hasła serwera na krótkotrwały grant. Sukces przełącza
   * okno na tego hosta i wiezie grant we fragmencie URL, więc zwrócona
   * obietnica zwykle ginie razem ze stroną — tak ma być.
   * Hasło jedzie tędy w jawnej postaci: NIGDY nie logować argumentów tego
   * wywołania ani nie przepisywać ich do żadnego stanu, który przeżyje ekran. */
  joinHost: (url, serverName, serverPassword) => ipcRenderer.invoke("hosts:join", url, serverName, serverPassword),
  /** Zapomina przypięty certyfikat hosta — jawna zgoda użytkownika po tym, jak
   * serwer wystawił sobie nowy. Bez tego „server certificate changed" nie ma
   * wyjścia, a z automatu byłoby to przypięcie tylko z nazwy. */
  forgetHostCertificate: (url) => ipcRenderer.invoke("hosts:forget-certificate", url),
  /** Otwiera natywny wybór hosta bez zmiany aktywnego hosta — „← Wstecz" na
   * ekranie logowania. Zmiana następuje dopiero po jawnym wyborze w tym oknie. */
  showHostPicker: () => ipcRenderer.invoke("hosts:open-picker"),

  /** Unread-conversation count for the taskbar badge (Windows overlay icon,
   * macOS/Linux dock badge). Fire-and-forget; dormant in plain browsers. */
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),

  /** Banerka systemowa. Renderer decyduje kiedy ją pokazać; proces główny ją
   * rysuje, bo tylko on potrafi po kliknięciu podnieść okno. Wtedy
   * onNotificationClick dostaje id bota do otwarcia i zwraca odsubskrybowanie. */
  notify: (payload) => ipcRenderer.send("desktop:notify", payload),
  onNotificationClick: (cb) => {
    const handler = (_event, botId) => cb(botId);
    ipcRenderer.on("desktop:notification-click", handler);
    return () => ipcRenderer.removeListener("desktop:notification-click", handler);
  },
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),

  /** Akceleracja sprzętowa. Zapis dopiero następnym uruchomieniem coś zmienia:
   * Electron rozstrzyga to przed gotowością aplikacji. */
  hardwareAcceleration: {
    get: () => ipcRenderer.invoke("prefs:hardware-acceleration"),
    set: (enabled) => ipcRenderer.invoke("prefs:set-hardware-acceleration", enabled),
    status: () => ipcRenderer.invoke("prefs:gpu-status"),
  },

  /** Własne kontrolki okna — obecne wyłącznie tam, gdzie okno leci bez ramki
   * systemowej (Windows, Linux). Nieobecne pod macOS i w przeglądarce, więc
   * ich obecność jest dla interfejsu jedynym sygnałem "rysujesz je sam". */
  window: customWindowChrome
    ? {
        minimize: () => ipcRenderer.send("window:minimize"),
        toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
        close: () => ipcRenderer.send("window:close"),
      }
    : undefined,

  /** In-app auto-update. State object:
   *  { status: "idle"|"checking"|"available"|"downloading"|"downloaded"|"error",
   *    version?, percent?, message? }. onState fires immediately with the
   *    current state, then on every transition. Dormant in dev (no bridge). */
  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    currentVersion: () => ipcRenderer.invoke("update:app-version"),
    onState: (cb) => {
      ipcRenderer
        .invoke("update:get-state")
        .then((s) => cb(s))
        .catch(() => {});
      const handler = (_event, s) => cb(s);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
});
