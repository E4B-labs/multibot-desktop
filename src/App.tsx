import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
// multibot: trzecia kopia tej samej linii (Onboarding.tsx, Sidebar.tsx) —
// zostaje lokalnie, bo wspólny moduł na jedno wyrażenie to więcej pliku niż
// treści. ponytail: wyciągnąć do `src/lib/`, gdyby doszła czwarta.
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { AppSettingsPanel } from "@/components/AppSettingsPanel";
import { TeamMapPanel } from "@/components/TeamMapPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
// multibot: F6 — panel rutyn bota
import { RoutinesPanel } from "@/components/RoutinesPanel";
// multibot: F8 — panel skilli bota
import { SkillsPanel } from "@/components/SkillsPanel";
// multibot: F9-FE — pokój grupowy
import { GroupPanel } from "@/components/GroupPanel";
import { GroupMembersPanel } from "@/components/GroupMembersPanel";
import { RoomPanel } from "@/components/RoomPanel";
import { RoomsPanel } from "@/components/RoomsPanel";
// multibot: własne min/max/zamknij — okno bez ramki systemowej (Windows,
// Linux). Komponent sam sprawdza mostek preloadu i w przeglądarce oraz pod
// macOS nie rysuje niczego.
import { WindowControls } from "@/components/WindowControls";
import { cn } from "@/lib/cn";
import { hasCustomWindowControls } from "@/lib/shell";
// multibot: stała, bo mostek preloadu jest na miejscu, zanim renderer wykona
// pierwszą linię — okno nie zmienia ramki w trakcie życia.
const frameless = hasCustomWindowControls();
// multibot: Cmd/Ctrl+K paleta komend
import { CmdK } from "@/components/CmdK";
import { authEventName, authFetch, clearAuthToken, getAuthToken, refreshAccessToken, setV2AuthToken } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { unreadConversationCount } from "@/lib/unread";

export type LoginMode = "login" | "register" | "host" | "recover";

/** Nagłówek ekranu logowania idzie z trybu, nie ze stanu serwera. Kiedy szedł
 * ze `configured`, ekran „dołącz do istniejącego" dalej miał na sobie „Utwórz
 * serwer" — użytkownik nie widział, że w ogóle przełączył formularz. */
export function loginTitle(mode: LoginMode, polish: boolean): string {
  if (mode === "host") return polish ? "Utwórz serwer" : "Create server";
  if (mode === "register") return polish ? "Dołącz do istniejącego serwera" : "Join existing server";
  if (mode === "recover") return polish ? "Odzyskaj konto" : "Recover account";
  return polish ? "Zaloguj się do serwera" : "Sign in to server";
}

/** Przełącznik trybu w stopce — też z trybu, nie ze stanu serwera. Wcześniej
 * warunkiem było samo `!configured`, więc po kliknięciu „Dołącz do
 * istniejącego" ten sam napis zostawał na ekranie i nie prowadził nigdzie. */
export function loginSwitch(
  mode: LoginMode,
  configured: boolean,
  polish: boolean,
): { next: LoginMode; label: string } | null {
  if (!configured)
    return mode === "host"
      ? { next: "register", label: polish ? "Dołącz do istniejącego serwera" : "Join existing server" }
      : { next: "host", label: polish ? "Utwórz serwer" : "Create server" };
  return mode === "login"
    ? { next: "register", label: polish ? "Utwórz profil" : "Create profile" }
    : { next: "login", label: polish ? "Mam już profil" : "I have an account" };
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const polish = useLanguage() === "pl";
  type Mode = LoginMode;
  type ServerInfo = { configured: boolean; name: string; serverId: string };
  type Status = { server?: ServerInfo };
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<Mode>("login");
  const [serverName, setServerName] = useState("");
  const [serverPassword, setServerPassword] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    // `/api/auth/status` skasowane razem ze starymi szynami logowania; stan
    // serwera czytamy z jedynej publicznej trasy. PR 7 przepisuje ten ekran.
    void fetch("/api/public/server")
      .then((response) => response.json() as Promise<ServerInfo>)
      .then((server) => {
        if (!alive) return;
        setStatus({ server });
        // The name is public and the user has to send it back with the join, so
        // prefill it instead of making them retype what is on the screen.
        setServerName((previous) => previous || server.name || "");
        if (!server.configured) setMode("host");
      })
      .catch(() => setError(polish ? "Nie można odczytać stanu serwera." : "Could not read server status."));
    return () => { alive = false; };
  }, [polish]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // 0.4.0: the server sets itself up on its first boot, so there is nothing
      // to create here. Every profile call first proves the device knows the
      // server name and password, and spends the 5-minute grant that proof
      // returns. PR 7 replaces this screen; this keeps it working until then.
      const deviceName = navigator.userAgent.slice(0, 80);
      const joined = await authFetch("/api/auth/join", { method: "POST", body: JSON.stringify({ serverName: serverName.trim(), serverPassword }) });
      const grant = await joined.json().catch(() => ({})) as { joinGrant?: string; error?: string };
      if (!joined.ok || !grant.joinGrant) throw new Error(grant.error ?? `Join failed (${joined.status})`);
      const joinGrant = grant.joinGrant;
      let response: Response;
      if (mode === "recover") {
        response = await authFetch("/api/auth/recover", { method: "POST", body: JSON.stringify({ username, recoveryCode, newPassword: password, joinGrant, deviceName }) });
      } else if (mode === "login") {
        response = await authFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password, joinGrant, deviceName }) });
      } else {
        response = await authFetch("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password, displayName, joinGrant, deviceName }) });
      }
      const body = await response.json().catch(() => ({})) as { accessToken?: string; recoveryCode?: string; error?: string };
      if (!response.ok || !body.accessToken) throw new Error(body.error ?? `Authentication failed (${response.status})`);
      setV2AuthToken(body.accessToken);
      if (body.recoveryCode) window.alert(`${polish ? "Zapisz recovery code. Pokażemy go tylko raz:" : "Save recovery code. It is shown once:"}\n\n${body.recoveryCode}`);
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const configured = status?.server?.configured ?? false;
  const field = "mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] text-ink outline-none focus:border-hairline";
  // „Wstecz" ma sens wyłącznie w powłoce desktopowej, gdzie otwiera wybór
  // hosta. W karcie przeglądarki nie ma dokąd wracać (ekran logowania jest
  // pierwszym wpisem historii), więc `history.back()` był po prostu niczym.
  // Wołało to kiedyś `useLocalHost`, czyli powrót z hosta zdalnego przestawiał
  // komputer na lokalny harness — teraz tylko pokazuje wybór, a host zmienia
  // się dopiero po jawnym kliknięciu w tym oknie.
  const backToHostPicker = window.ogb?.showHostPicker;
  const switchLink = loginSwitch(mode, configured, polish);
  return (
    <main className="multibot-login flex h-full min-h-screen items-center justify-center bg-app px-5 text-ink">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl">
        {backToHostPicker && <button type="button" onClick={() => void backToHostPicker()} className="mb-4 text-left text-[12px] text-ink-secondary hover:text-ink">
          ← {polish ? "Wstecz" : "Back"}
        </button>}
        <h1 className="text-[18px] font-semibold">{loginTitle(mode, polish)}</h1>
        <p className="mt-1 text-[13px] text-ink-secondary">{status?.server?.name ?? (polish ? "Bezpieczny wspólny workspace" : "Secure shared workspace")}</p>
        {/* Name and password are needed by every mode now: they are the two
            values `/api/auth/join` checks before a profile call is allowed. */}
        <input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder={polish ? "Nazwa serwera" : "Server name"} aria-label="Server name" className={field} />
        {(mode === "register" || mode === "host") && <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={polish ? "Nazwa profilu" : "Display name"} aria-label="Display name" className={field} />}
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" aria-label="Username" autoComplete="username" className={field} />
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "recover" ? polish ? "Nowe hasło profilu" : "New profile password" : polish ? "Hasło profilu" : "Profile password"} aria-label="Profile password" autoComplete={mode === "login" ? "current-password" : "new-password"} className={field} />
        <input type="password" value={serverPassword} onChange={(event) => setServerPassword(event.target.value)} placeholder={polish ? "Hasło serwera" : "Server password"} aria-label="Server password" autoComplete="off" className={field} />
        {mode === "recover" && <input value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} placeholder={polish ? "Jednorazowy recovery code" : "One-time recovery code"} aria-label="Recovery code" autoComplete="one-time-code" className={field} />}
        {/* rejestracja na serwerze bez właściciela kończy się 409 „server setup
            required" (server/identity.ts) — nie ma tu żadnego adresu obcego
            hosta, wszystko idzie na to samo pochodzenie. */}
        {mode === "register" && !configured && <p className="mt-2 text-[12px] text-ink-secondary">{polish ? "Ten serwer nie ma jeszcze właściciela — najpierw trzeba go utworzyć. Do cudzego serwera dołączasz, otwierając jego adres." : "This server has no owner yet — it has to be created first. You join someone else's server by opening its address."}</p>}
        <button type="submit" disabled={busy} className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[13px] font-medium text-white disabled:opacity-50">
          {busy ? (polish ? "Praca…" : "Working…") : mode === "host" ? polish ? "Utwórz serwer i profil" : "Create server and profile" : mode === "register" ? polish ? "Dołącz i utwórz profil" : "Join and create profile" : mode === "recover" ? polish ? "Odzyskaj konto" : "Recover account" : polish ? "Zaloguj się" : "Sign in"}
        </button>
        <div className="mt-4 flex flex-wrap gap-2 text-[12px] text-ink-secondary">
          {switchLink && <button type="button" onClick={() => setMode(switchLink.next)} className="hover:text-ink">{switchLink.label}</button>}
          {configured && mode !== "recover" && <button type="button" onClick={() => setMode("recover")} className="hover:text-ink">{polish ? "Odzyskaj" : "Recover"}</button>}
        </div>
        {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      </form>
    </main>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];
  useEffect(() => {
    const close = () => dispatch({ type: "toggleInspector", open: false });
    window.addEventListener("mb:inspector:close", close);
    return () => window.removeEventListener("mb:inspector:close", close);
  }, [dispatch]);
  // multibot: tapnięcie w powiadomienie na telefonie ustawia `#bot=<id>` —
  // powłoka mobilna wstrzykuje hash i przy starcie, i przy otwartej aplikacji,
  // więc czytamy go też z `hashchange`.
  useEffect(() => {
    const openFromHash = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get("bot");
      if (id && state.bots.some((b) => b.id === id) && id !== state.selectedId) dispatch({ type: "select", id });
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [state.bots, state.selectedId, dispatch]);
  // …a powłoka musi wiedzieć, który bot jest na ekranie, żeby nie wyświetlać
  // powiadomienia o bocie, na który użytkownik właśnie patrzy.
  useEffect(() => {
    const rn = (window as unknown as { ReactNativeWebView?: { postMessage(m: string): void } }).ReactNativeWebView;
    if (rn && bot) rn.postMessage(JSON.stringify({ type: "bot.selected", botId: bot.id }));
  }, [bot?.id]);
  // multibot: nieprzeczytane rozmowy → badge na pasku zadań (Electron only).
  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadConversationCount(state.bots));
  }, [state.bots]);
  return (
    <div className={cn("multibot-shell flex h-full flex-col", frameless && "multibot-frameless")}>
      {/* multibot: Cmd/Ctrl+K command palette — fixed overlay, renders null until opened */}
      <CmdK />
      <div className="relative flex min-h-0 flex-1">
        {state.appSettingsOpen ? (
          <AppSettingsPanel />
        ) : (
          <>
            <Sidebar />
            {state.roomsOpen ? (
              <RoomsPanel />
            ) : state.roomOpen ? (
              <RoomPanel />
            ) : state.groupOpen ? (
              <GroupPanel key={state.groupOpen.id} group={state.groupOpen} />
            ) : bot ? (
              <ChatView bot={bot} />
            ) : (
              <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
                <Loader2 size={20} className="animate-spin" />
                <div className="text-[14px]">
                  {state.connected ? (polish ? "Brak botów" : "No bots yet") : polish ? "Łączenie z serwerem botów…" : "Connecting to the bot server…"}
                </div>
                {!state.connected && (
                  <div className="text-[12px]">
                    {polish ? "Uruchom:" : "Start it with"} <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
                  </div>
                )}
              </main>
            )}
            {/* multibot: wejscie w grupe od razu pokazuje sklad po prawej,
                w tym samym slocie co ustawienia bota. */}
            {state.groupOpen && !state.routinesOpen && <GroupMembersPanel group={state.groupOpen} />}
            {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
            {state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
            {state.computerOpen && bot && <ComputerPanel bot={bot} />}
            {/* multibot: routines are harness-owned and available for every driver. */}
            {state.routinesOpen && bot && <RoutinesPanel key={`${bot.id}-${state.workspaceVersion}`} bot={bot} />}
            {state.skillsOpen && bot && <SkillsPanel key={`${bot.id}-${state.workspaceVersion}`} bot={bot} />}
            {/* multibot: live team map (port z OpenMausBot) — globalny overlay */}
            {state.teamMapOpen && (
              <TeamMapPanel onClose={() => dispatch({ type: "toggleTeamMap", open: false })} />
            )}
            {/* multibot: F9-FE — pokój grupowy; otwierany wyłącznie z sekcji Groups,
                klucz per grupę = świeży mount */}
            {state.pluginsOpen && <PluginsPanel />}
          </>
        )}
      </div>
      {/* multibot: kontrolki okna siedzą poza układem, bo nagłówek czatu znika
          przy ustawieniach aplikacji i przy pustym stanie, a zamknąć okno
          trzeba dać się zawsze.

          MUSZĄ być OSTATNIE w drzewie. Chromium składa regiony
          -webkit-app-region w kolejności drzewa i późniejszy `drag` nadpisuje
          wcześniejszy `no-drag` na tym samym obszarze. Kontrolki leżą nad
          nagłówkiem, który jest uchwytem do przeciągania okna — postawione
          wyżej niż on stają się częścią uchwytu i klik w minimalizuj albo
          zamknij tylko przeciąga okno, zamiast działać (0.1.90).
          Pilnuje tego WindowControls.test.ts. */}
      <WindowControls />
    </div>
  );
}

export default function App() {
  // multibot: onboarding pokazujemy, dopóki użytkownik go nie domknął. Token w
  // localStorage traktujemy jak dowód konfiguracji TYLKO w przeglądarce: tam
  // musiał go skądś wziąć, więc po deployu i reloadzie gate nie wraca.
  //
  // Pod Electronem token nie dowodzi niczego — spakowana apka wstawia własny
  // przez fragment adresu przy PIERWSZYM starcie. Zliczanie go jako
  // konfiguracji kasowało onboarding, zanim się pokazał, a razem z nim jedyne
  // wejście do konfiguracji serwera (kreator w `Onboarding`). Efekt: świeża
  // instalacja desktopowa wchodziła od razu do aplikacji, z pominięciem
  // całego kreatora.
  // …ALE ten wyjątek dotyczy tylko Electrona z LOKALNYM serwerem. W trybie
  // zdalnym (C2) okno ładuje interfejs prosto z cudzego hosta, a token wjeżdża
  // fragmentem adresu — Electron jest wtedy tylko widzem i onboarding „postaw
  // serwer" nie ma sensu; bez tego rozróżnienia panel wyboru wyskakiwał w
  // aplikacji desktopowej przy każdym połączeniu ze zdalnym serwerem.
  // Sam hostname już nie wystarcza: w trybie zdalnym apka podnosi u siebie
  // proxy na 127.0.0.1 i to z niego bierze interfejs (electron/remote-ui.mjs),
  // więc oba tryby wyglądają stąd tak samo i panel „postaw serwer" wracał w
  // trybie zdalnym po aktualizacji. Rozstrzyga flaga, którą proxy wstrzykuje
  // do `index.html` — lokalny harness nigdy jej nie wysyła. Hostname ZOSTAJE
  // jako drugi warunek, bo gdy proxy nie wstanie, main.mjs celowo ładuje
  // interfejs prosto z hosta: flagi wtedy nie ma, ale adres jest zdalny.
  const configured = emailGateDone() || Boolean(getAuthToken());
  const [gated, setGated] = useState(() => !configured);
  // Ciasteczko sesji (`mb_v2_session`) siedzi w HttpOnly i żyje dłużej niż
  // 15-minutowy token dostępu, więc pusty localStorage to jeszcze nie
  // wylogowanie: tryb prywatny, wyczyszczone dane albo jedno błędne 401 i
  // token znika, choć serwer nadal nas zna. Zanim pokażemy formularz, prosimy
  // sesję o nowy token — jedno wołanie, które przy okazji od razu go daje.
  const [authenticated, setAuthenticated] = useState(() => Boolean(getAuthToken()));
  const [checkingSession, setCheckingSession] = useState(() => !getAuthToken());
  useEffect(() => {
    initAnalytics();
    const onAuthRequired = () => {
      clearAuthToken();
      setAuthenticated(false);
    };
    window.addEventListener(authEventName(), onAuthRequired);
    if (checkingSession) void refreshAccessToken().then((result) => {
      if (result === "ok") setAuthenticated(true);
      setCheckingSession(false);
    });
    return () => window.removeEventListener(authEventName(), onAuthRequired);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sonda sesji leci raz, przy montowaniu
  }, []);
  // Zalogowanie gasi też bramkę: skoro serwer przyjął token (albo ciasteczko,
  // albo Google), to istnieje i jest skonfigurowany — onboarding „postaw
  // serwer" nie ma po nim sensu. Bez tego świeża przeglądarka liczyła
  // `configured` PRZED zalogowaniem (token jeszcze pusty), więc zaraz po
  // wpisaniu tokenu nad aplikacją wyskakiwał drugi panel logowania.
  // Pusty ekran, a nie mignięcie formularzem, gdy sesja właśnie się potwierdza.
  if (checkingSession) return null;
  if (!authenticated) return <LoginScreen onLogin={() => { setAuthenticated(true); setGated(false); }} />;
  return (
    <StoreProvider>
      <Shell />
      {gated && <Onboarding onDone={() => setGated(false)} />}
    </StoreProvider>
  );
}
