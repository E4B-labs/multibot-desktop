import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, Notification, screen, session, shell, systemPreferences, utilityProcess } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { addRemoteHost, getActiveId, listRemoteHosts, removeHost, resolveLoadTarget, setActiveHost } from "./hosts.mjs";
import { shouldStartLocalHarness } from "./host-resolve.mjs";
import { isLocalSender } from "./local-origin.mjs";
import { activateExistingWindow } from "./single-instance.mjs";
import { activateForBot, normalizeNotification } from "./notifications.mjs";
import { startRemoteUiServer } from "./remote-ui.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import { buildDiagnosticsReport, decodeLogTail, diagnosticsFileName } from "./diagnostics.mjs";

const require = createRequire(import.meta.url);
const { normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");
const { parseHardwareAcceleration, withHardwareAcceleration } = require("./hardware-acceleration.cjs");
const { gpuCommandLineSwitches, summarizeGpuFeatureStatus } = require("./gpu.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// multibot (G6): Task Scheduler starts packaged app without a window. Electron
// supplies Node + bundled harness/UI, so clean Windows needs no Node or pnpm.
const SERVER_ONLY = process.argv.includes("--server-only");
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");

// multibot: akceleracja sprzętowa. DOMYŚLNIE WYŁĄCZONA (Kacper 29.08) —
// Electron włącza ją sam, więc to my ją zdejmujemy, dopóki użytkownik nie
// przestawi przełącznika w Ustawieniach → Narzędzia.
//
// Musi to pójść TUTAJ, na górze modułu: „disableHardwareAcceleration()” działa
// wyłącznie zanim aplikacja stanie się gotowa. Dlatego preferencja leży
// w zwykłym pliku JSON i czyta się ją synchronicznie — z rendererem byłoby
// już za późno. Z tego samego powodu zmiana wymaga restartu aplikacji.
function appPrefsFile() {
  return path.join(app.getPath("userData"), "app-prefs.json");
}

function hardwareAccelerationEnabled() {
  try {
    return parseHardwareAcceleration(fs.readFileSync(appPrefsFile(), "utf8"));
  } catch {
    return true;
  }
}

// Electron's default GPU pipeline is intentionally retained. These switches
// make the local UI's rasterization path explicit; they must be registered
// before app.whenReady(), just like disableHardwareAcceleration(). A user can
// still opt out when a driver is unstable, and that choice applies next boot.
const hardwareAccelerationAtStartup = hardwareAccelerationEnabled();
if (hardwareAccelerationAtStartup) {
  for (const switchName of gpuCommandLineSwitches(hardwareAccelerationAtStartup)) app.commandLine.appendSwitch(switchName);
} else {
  app.disableHardwareAcceleration();
}

// With no preference file, hardwareAccelerationEnabled() resolves to true.
// The old opt-out remains available for driver troubleshooting.
function gpuStatus() {
  const enabled = hardwareAccelerationEnabled();
  try {
    return summarizeGpuFeatureStatus(app.getGPUFeatureStatus(), enabled);
  } catch {
    return summarizeGpuFeatureStatus(null, enabled);
  }
}
// multibot: Windows i Linux jadą bez ramki systemowej — jasny pasek tytułu
// z ikoną i min/max/close siedział osobnym pasem nad interfejsem, więc
// kontrolki okna rysuje sobie sam interfejs (src/components/WindowControls.tsx)
// w tym samym rzędzie co reszta przycisków. macOS zostaje na ramce systemowej:
// tam okno i tak nie ma paska tytułu, a światła sygnalizacyjne daje system.
// Preload czyta ten sam warunek — obie strony muszą zgadzać się co do tego,
// kto rysuje kontrolki, bo inaczej okna albo nie da się zamknąć, albo dostaje
// dwa komplety przycisków.
const CUSTOM_WINDOW_CHROME = process.platform !== "darwin";

// multibot: one desktop app per user session. The headless --server-only
// Task Scheduler instance must NOT take the lock — it has no window, so a
// second launch absorbed into it would just die and the UI would never open.
if (!SERVER_ONLY && !app.requestSingleInstanceLock()) {
  console.log("[desktop] MultiBot is already running — focusing that window");
  process.exit(0);
}
app.on("second-instance", () => {
  activateExistingWindow([mainWindow]);
});

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
// multibot (C2): the main window, kept so the host picker and IPC handlers
// can retarget it without tearing it down. The picker is a separate small
// window, opened on demand — it never replaces the harness UI window.
let mainWindow = null;
let pickerWindow = null;
// multibot: zapamiętana geometria okna głównego — <userData>/window-state.json,
// atomiczny zapis (tmp+rename), debounce 250 ms na resize/move, flush przy zamknięciu.
function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function savedWindowState() {
  try {
    return parseWindowState(fs.readFileSync(windowStateFile(), "utf8"));
  } catch {
    return null;
  }
}

// workAreas muszą mieć primary pierwszym — resolveWindowState() centruje tam
// okna uratowane po zmianie monitora/DPI.
function workAreasPrimaryFirst() {
  const primary = screen.getPrimaryDisplay();
  const displays = [...screen.getAllDisplays()].sort((a) => (a.id === primary.id ? -1 : 0));
  return displays.map((d) => d.workArea);
}

let saveStateTimer = null;
function scheduleWindowSave(win) {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    try {
      const state = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
      const file = windowStateFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* geometry saving is best-effort */
    }
  }, 250);
}

function trackWindowForState(win) {
  const events = ["resize", "move", "maximize", "unmaximize"];
  for (const ev of events) win.on(ev, () => scheduleWindowSave(win));
  win.on("close", () => {
    if (saveStateTimer) {
      clearTimeout(saveStateTimer);
      saveStateTimer = null;
      try {
        const state = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
        fs.writeFileSync(windowStateFile(), JSON.stringify(state), { mode: 0o600 });
      } catch {}
    }
  });
}

// multibot: nieprzeczytane rozmowy jako plakietka doku (macOS, Linux).
// Liczbę przelicza renderer i tu ją wysyła.
//
// Windows celowo bez plakietki: setOverlayIcon dostawał tę samą ikonę
// aplikacji przeskalowaną do 16 px, więc przy nieprzeczytanych rozmowach
// pasek zadań pokazywał ikonę MultiBota, a w jej rogu drugą, mniejszą kopię
// tej samej ikony. Wyglądało to na dwie ikony jednej aplikacji, a nie na
// licznik. Kacper 28.08 — zdejmujemy; wróci dopiero z osobną grafiką
// plakietki (kropka albo liczba), nie z miniaturą ikony.
ipcMain.handle("prefs:hardware-acceleration", () => hardwareAccelerationEnabled());
ipcMain.handle("prefs:gpu-status", () => gpuStatus());
ipcMain.handle("prefs:set-hardware-acceleration", (_event, enabled) => {
  const file = appPrefsFile();
  let raw = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    /* pierwszy zapis — plik jeszcze nie istnieje */
  }
  const next = withHardwareAcceleration(raw, enabled);
  // Zapis przez plik tymczasowy i rename, tak jak stan okna: ubicie procesu
  // w połowie zapisu nie zostawi uciętego JSON-a, który przy starcie
  // cofnąłby ustawienie do domyślnego.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next.hardwareAcceleration;
});

ipcMain.on("desktop:unread-count", (_event, rawCount) => {
  const count = normalizeUnreadCount(rawCount);
  if (process.platform === "darwin") {
    app.setBadgeCount(count === 999 ? 999 : count);
  } else if (process.platform === "linux") {
    app.setBadgeCount(count);
  }
});

// multibot: banerka systemowa, gdy bot skończy odpowiedź, prosi o decyzję albo
// pokój współpracy zamknie temat. O tym, KIEDY ją pokazać, decyduje renderer
// (src/lib/notifications.ts) — on jeden wie, na co patrzysz. Tu zostaje samo
// rysowanie i kliknięcie: okno na wierzch i wybór bota w interfejsie.
ipcMain.on("desktop:notify", (_event, raw) => {
  const payload = normalizeNotification(raw);
  if (!payload || !Notification.isSupported()) return;
  const banner = new Notification({ title: payload.title, body: payload.body });
  banner.on("click", () => activateForBot(mainWindow, payload.botId));
  banner.show();
});

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_HOST: "127.0.0.1", // Tailscale Serve terminates HTTPS on loopback.
      OMB_PORT: String(port),
      // Trusted packaged path; used only after explicit onboarding 24/7 choice.
      OMB_PACKAGED_EXE: app.isPackaged && process.platform === "win32" ? process.execPath : "",
      OMB_SERVER_SERVICE: SERVER_ONLY ? "1" : "",
    },
    stdio: "inherit",
  });
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  for (let i = 0; i < 40; i++) {
    if (exited) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "multibot" && body.pid === proc.pid && body.static) return proc;
        break; // someone else owns this port — try the next one
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      // A server-only ONLOGON task deliberately outlives desktop UI. Reuse only
      // an explicit service marker; never trust an arbitrary dev harness.
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        const body = res.ok ? await res.json() : null;
        if (body?.app === "multibot" && body?.static === true && body?.service === true) {
          serverProc = null;
          SERVER_PORT = port;
          return true;
        }
      } catch {
        /* no installed service on this port */
      }
      const proc = await startServerOn(port);
      if (proc) {
        serverProc = proc;
        SERVER_PORT = port;
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

// multibot: lokalny harness wstaje LENIWIE. Przy starcie z aktywnym hostem
// zdalnym nie forkujemy go wcale (patrz shouldStartLocalHarness), więc trzeba
// go podnieść w chwili, gdy użytkownik faktycznie przełączy się na „to
// urządzenie". Jedno miejsce dla wszystkich dróg do trybu lokalnego —
// loadActiveTarget() jest wąskim gardłem obu handlerów `hosts:*`.
// Nieudany start nie zapala flagi: kolejne przełączenie ma prawo spróbować
// jeszcze raz zamiast pokazywać ERROR_PAGE do końca sesji.
let localHarnessStarted = false;
async function ensureLocalHarness() {
  if (!app.isPackaged || localHarnessStarted) return serverReady;
  serverReady = await startServerPackaged();
  localHarnessStarted = serverReady;
  return serverReady;
}

const ERROR_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">◈</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">Something else is using its ports. Quit and reopen MultiBot — if it keeps happening, restart your device.</p></div></body>`,
  );

// multibot (C2): fragment credential hand-off for a remote host's token.
// Never reaches HTTP — src/lib/auth.ts's bootstrapLocalAuthToken() reads
// window.location.hash client-side, stores it, and erases it before first
// paint.
function remoteFragment(token) {
  return token ? `#access_token=${encodeURIComponent(token)}` : "";
}

// multibot: katalog z ZAPAKOWANYM interfejsem — tym, który przychodzi razem z
// aktualizacją. W paczce leży w Resources (ten sam, z którego korzysta lokalny
// harness), w repo — w `dist` po `vite build`.
const BUNDLED_UI_DIR = app.isPackaged ? path.join(process.resourcesPath, "ui") : path.join(__dirname, "..", "dist");

// Lokalny origin obsługujący aktywnego hosta zdalnego; `null`, dopóki go nie ma.
let remoteUi = null;

async function closeRemoteUi() {
  if (!remoteUi) return;
  const closing = remoteUi;
  remoteUi = null;
  await closing.close().catch(() => {});
}

/**
 * Podnosi (albo odzyskuje) lokalny origin dla tego hosta. `null` oznacza, że
 * się nie udało — wtedy wracamy do ładowania interfejsu prosto z hosta, czyli
 * do zachowania sprzed tej zmiany. Awaria tego serwera ma degradować apkę do
 * poprzedniego trybu, nigdy do białego ekranu.
 */
async function remoteUiOriginFor(remoteUrl) {
  if (remoteUi && remoteUi.remoteUrl === remoteUrl) return remoteUi.url;
  await closeRemoteUi();
  try {
    remoteUi = await startRemoteUiServer({ staticDir: BUNDLED_UI_DIR, remoteUrl });
  } catch (err) {
    console.warn("[multibot] lokalny origin nie wstał:", err?.message ?? err);
    remoteUi = null;
  }
  return remoteUi?.url ?? null;
}

/** Tryb zapisanego celu, odporny na wywrotkę. `resolveLoadTarget()` odszyfrowuje
 * token przez safeStorage i potrafi rzucić (przeniesiony profil, brak pęku
 * kluczy); na starcie kosztowałoby to całe okno, więc taka awaria degraduje do
 * dotychczasowego zachowania, czyli trybu lokalnego. */
function startupTargetMode() {
  try {
    return resolveLoadTarget().mode;
  } catch {
    return "local";
  }
}

/** Decides what `win` should load: a saved remote host, or the existing
 * local flow (packaged server / dev vite), completely unchanged when no
 * remote host is active. */
async function loadActiveTarget(win) {
  const target = resolveLoadTarget();
  if (target.mode === "remote") {
    // multibot: interfejs bierzemy z PACZKI, a z hosta wyłącznie dane. Wcześniej
    // `loadURL` szedł prosto na adres hosta, więc ekran przychodził z telefonu i
    // żadna poprawka wyglądu nie docierała do użytkownika przez aktualizację —
    // instalator wiózł interfejs, którego apka w tym trybie nigdy nie otwierała.
    // Jak to działa i dlaczego bez CORS: electron/remote-ui.mjs.
    const origin = await remoteUiOriginFor(target.url);
    win.loadURL(`${origin ?? target.url}/${remoteFragment(target.token)}`);
    return;
  }
  // Wracamy na lokalny harness — port zdalnego originu nie ma po co wisieć.
  await closeRemoteUi();
  if (app.isPackaged) {
    // Start z aktywnym hostem zdalnym pomija harness — dopiero tutaj, gdy
    // celem naprawdę jest tryb lokalny, wolno go podnieść.
    await ensureLocalHarness();
    // Fragment never reaches HTTP. Renderer stores it, then erases URL before
    // first paint, so fresh packaged installs do not deadlock on login.
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}/` : ERROR_PAGE);
  } else {
    win.loadURL(DEV_URL);
  }
}

function createWindow() {
  const saved = savedWindowState();
  const restored = resolveWindowState(saved, workAreasPrimaryFirst());
  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    ...(CUSTOM_WINDOW_CHROME
      ? { frame: false }
      : { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } }),
    // Pasek menu (File/Edit/View/Host/Window) schowany — Kacper 21.08. Menu
    // zostaje zbudowane, bo niesie role schowka i skrót Ctrl+Shift+H do
    // zmiany hosta; pod macOS Alt pokazuje pasek na chwilę, gdy ktoś go
    // potrzebuje. Bez ramki (Windows, Linux) paska nie ma czym pokazać —
    // zostają same skróty.
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  if (restored.maximized) win.maximize();
  trackWindowForState(win);

  // multibot: natywne menu kontekstowe — edycja w polach tekstowych,
  // sugestie spellchecka i kopiowanie linków. Bez actionable pozycji nie
  // wyskakuje wcale (czysty klik prawym na tle ma być cichy).
  win.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable && !params.linkURL && !params.misspelledWord && !params.selectionText) return;
    const items = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
      }
      items.push(
        { type: "separator" },
        {
          label: "Add to dictionary",
          click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: "separator" },
      );
    }
    if (params.linkURL) {
      items.push({ label: "Copy Link", click: () => clipboard.writeText(params.linkURL) }, { type: "separator" });
    }
    const flags = params.editFlags;
    for (const [label, role, can] of [
      ["Undo", "undo", flags.canUndo],
      ["Redo", "redo", flags.canRedo],
      ["Cut", "cut", flags.canCut],
      ["Copy", "copy", flags.canCopy],
      ["Paste", "paste", flags.canPaste],
      ["Paste and Match Style", "pasteAndMatchStyle", flags.canPaste],
      ["Select All", "selectAll", flags.canSelectAll],
    ]) {
      if (can) items.push({ label, role });
    }
    if (items.length > 0 && items[items.length - 1]?.type === "separator") items.pop();
    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: win, frame: params.frame });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  void loadActiveTarget(win);
  return win;
}

// multibot: własne kontrolki okna. Bez ramki systemowej nic poza tymi trzema
// kanałami nie zminimalizuje ani nie zamknie okna, więc rejestrujemy je
// dokładnie tam, gdzie ramkę zdjęliśmy — pod macOS robi to system.
if (CUSTOM_WINDOW_CHROME) {
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on("window:close", () => mainWindow?.close());
}

// multibot (C2): small native window for switching between the local
// harness and a saved remote host. Separate from the harness UI itself
// (that's src/components/ territory) — this window only ever shows
// electron/host-picker.html, never a remote origin.
function openHostPicker() {
  if (pickerWindow) {
    pickerWindow.focus();
    return;
  }
  pickerWindow = new BrowserWindow({
    width: 480,
    height: 640,
    parent: mainWindow ?? undefined,
    icon: APP_ICON,
    backgroundColor: "#070707",
    title: "MultiBot — Host",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "host-picker-preload.cjs"),
    },
  });
  pickerWindow.setMenuBarVisibility(false);
  void pickerWindow.loadFile(path.join(__dirname, "host-picker.html"));
  pickerWindow.on("closed", () => {
    pickerWindow = null;
  });
}

// Role-based template: `appMenu`/`editMenu`/`windowMenu` are Electron's
// built-in menus and already carry the standard items (Copy/Paste/Quit/…) —
// building a custom menu without them silently breaks clipboard shortcuts,
// which is why this reuses the roles instead of listing items by hand.
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Host",
      submenu: [{ label: "Switch Host…", accelerator: "CmdOrCtrl+Shift+H", click: () => openHostPicker() }],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server.
// C2 remote mode: the window can show an arbitrary host's page, so this
// (and speech:start, perm:request-mic below) must refuse anything not from
// our own local origin — see electron/local-origin.mjs.
ipcMain.handle("screen:frame", async (event) => {
  if (!isLocalSender(event)) return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
ipcMain.handle("perm:status", () => ({
  mic: systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown",
}));
ipcMain.handle("perm:request-mic", async (event) => {
  if (!isLocalSender(event)) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", (_event, pane) => {
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
  };
  return shell.openExternal(
    `x-apple.systempreferences:com.apple.preference.security?${panes[pane] ?? "Privacy"}`,
  );
});

ipcMain.handle("speech:start", (event) => {
  if (!isLocalSender(event)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => stopSpeech());

// multibot (C2): host switching for the picker window (electron/hosts.mjs
// owns persistence + safeStorage encryption).
ipcMain.handle("hosts:list", () => ({ activeId: getActiveId(), hosts: listRemoteHosts() }));
ipcMain.handle("hosts:add-remote", (_event, host) => addRemoteHost(host ?? {}));
ipcMain.handle("hosts:remove", (_event, id) => removeHost(id));
// multibot: „← Wstecz" z ekranu logowania. Otwiera wyłącznie natywny wybór
// hosta — NIE przestawia activeId. Wcześniej ten przycisk wołał
// `hosts:use-local`, więc powrót z hosta zdalnego cicho przełączał komputer na
// lokalny harness; host zmienia się teraz dopiero, gdy użytkownik jawnie
// kliknie „Use" przy „This device".
ipcMain.handle("hosts:open-picker", () => openHostPicker());
ipcMain.handle("hosts:use-local", async () => {
  setActiveHost("local");
  if (mainWindow) await loadActiveTarget(mainWindow);
});
ipcMain.handle("hosts:use-host", async (_event, id) => {
  setActiveHost(id);
  if (mainWindow) await loadActiveTarget(mainWindow);
});
ipcMain.handle("desktop:export-diagnostics", async (event) => {
  if (!isLocalSender(event)) return { ok: false, error: "forbidden" };
  const picked = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "Export MultiBot diagnostics",
    defaultPath: path.join(app.getPath("documents"), diagnosticsFileName()),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  let logTail = Buffer.alloc(0);
  try {
    const log = fs.readFileSync(path.join(app.getPath("logs"), "server.log"));
    logTail = log.subarray(Math.max(0, log.length - 128 * 1024));
  } catch {}
  let configSummary = {};
  try {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`);
    if (response.ok) configSummary = await response.json();
  } catch {}
  const gpu = gpuStatus();
  const report = buildDiagnosticsReport({
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
      uptimeSeconds: Math.round(process.uptime()),
      gpuAcceleration: gpu.active ? "active" : gpu.enabled ? "enabled-but-not-active" : "disabled",
      gpuCompositing: gpu.compositing,
      gpuRasterization: gpu.rasterization,
    },
    configSummary,
    logTail: decodeLogTail(logTail, logTail.length === 128 * 1024).tail,
  });
  fs.writeFileSync(picked.filePath, report, { mode: 0o600 });
  return { ok: true, path: picked.filePath };
});

app.whenReady().then(async () => {
  if (SERVER_ONLY) {
    if (!app.isPackaged) {
      console.error("--server-only requires packaged app");
      return app.exit(1);
    }
    serverReady = await startServerPackaged();
    if (!serverReady) app.exit(1);
    return;
  }
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  // getDisplayMedia in the renderer → this handler → ScreenCaptureKit, all
  // inside the app's own processes — the one capture path macOS reliably
  // attributes to the app (registers it in the Screen Recording pane and
  // prompts). Used by the onboarding "Enable screen preview" button.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  buildAppMenu();
  registerCuaIpc();
  registerUpdaterIpc();
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  startCua().catch((e) => console.error("[cua] start failed:", e));
  // multibot (G3): provisioning starts only after the onboarding 24/7 choice;
  // the authenticated harness endpoint runs the same bundled script.
  //
  // multibot: gdy aktywny jest host zdalny, harness NIE wstaje — ten komputer
  // jest wtedy wyłącznie klientem telefonu, a fork serwera zakładałby mu
  // ~/.openmausbot i witał ekranem „server setup required". Tryb lokalny
  // zachowuje dotychczasową kolejność (serwer gotowy przed oknem).
  if (shouldStartLocalHarness({ isPackaged: app.isPackaged, mode: startupTargetMode() })) await ensureLocalHarness();
  const win = createWindow();
  // in-app auto-update (packaged only) — checks GitHub releases, downloads on
  // the user's click, installs on "Restart to update"
  startUpdater(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!SERVER_ONLY && process.platform !== "darwin") app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
let cuaCleanedUp = false;
app.on("before-quit", (e) => {
  if (cuaCleanedUp) return;
  e.preventDefault();
  try {
    serverProc?.kill();
  } catch {}
  stopCua().finally(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});
