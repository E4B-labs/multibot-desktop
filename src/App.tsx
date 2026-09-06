import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { initAnalytics } from "@/lib/analytics";
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
import { authEventName, clearAuthToken, getAuthToken, refreshAccessToken } from "@/lib/auth";
import { registerPushViaShell, shellPost } from "@/lib/shell";
import { useLanguage } from "@/lib/language";
import { unreadConversationCount } from "@/lib/unread";

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
    if (bot) shellPost({ type: "bot.selected", botId: bot.id });
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
  // Onboarding IS the sign-in screen now (src/components/Onboarding.tsx): the
  // first thing every device shows is "set up a server" or "sign in to one",
  // and reaching the app at all means a profile on some server accepted us.
  // Nothing local — no token, no analytics gate — decides that any more.
  //
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
  // Push na telefonie: powłoka mobilna przestała rejestrować go sama (PR #30 w
  // multibot-mobile). Ona ma zgodę systemową i token Expo, my mamy sesję, która
  // mówi, CZYJE to urządzenie — więc pytamy ją o token i sami go zgłaszamy.
  // Raz na start aplikacji: to jedna wiadomość, a przy okazji ponawia
  // rejestrację, którą serwer odrzucił, i łapie token obrócony przez system.
  useEffect(() => {
    if (!authenticated) return;
    void registerPushViaShell();
  }, [authenticated]);
  // Pusty ekran, a nie mignięcie formularzem, gdy sesja właśnie się potwierdza.
  if (checkingSession) return null;
  if (!authenticated) return <Onboarding onDone={() => setAuthenticated(true)} />;
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
