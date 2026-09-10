// The bot's computer, in the right-side slot. H1/H2 (server/hosted-computer.ts)
// give every bot exactly one computer: a persistent Linux desktop in a
// container, alive from bot creation to bot deletion. There is no source
// picker and no "off" — opening this panel attaches to a screen that is
// already running, it never starts or stops anything.
//
// The screen itself is the container's own noVNC, proxied by the harness so
// the client never learns the container port — rendered here in a plain
// <iframe>, no VNC client of our own. H5 layers a short input lease on top:
// the agent owns input by default; the user can take it, see-through
// continues either way (agent can always watch, never blocked from reading).
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, GraduationCap, Hand, Loader2, Maximize2, MousePointer2, Settings, Square, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { authFetch, getAuthToken } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";
import { TeachCard } from "./SkillsPanel";
import { SidePanel } from "./ResizablePanel";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** Straight from the server (server/hosted-computer.ts ComputerState). */
export type ComputerState = "provisioning" | "ready" | "recovering" | "error";
/** H5 input lease (server/computer-control.ts). */
export type ControlOwner = "agent" | "user";
type AgentQueue = { agentOwner?: string; agentQueue?: string[] };

/** State → the one label PLAN-COMPUTER.md H4 allows for it. */
export function computerStateLabel(state: ComputerState, polish: boolean): string {
  switch (state) {
    case "provisioning":
      return polish ? "Uruchamianie komputera…" : "Starting computer…";
    case "ready":
      return polish ? "Komputer gotowy" : "Computer ready";
    case "recovering":
      return polish ? "Wznawianie…" : "Recovering…";
    case "error":
      return polish ? "Błąd komputera" : "Computer error";
  }
}

/** The noVNC iframe src. view_only=1 iff the agent (not this viewer) holds
 *  the input lease — H5: "When the user does not hold the lease the iframe
 *  is view_only=1."
 *
 *  `token` (optional) is appended to the websockify path, not to the page URL:
 *  the page + assets are served public (statyczny klient noVNC), a mobile
 *  WebView iframe carries no cookie, and noVNC builds its WebSocket URL from
 *  the `path` param — so the bearer rides the upgrade request as ?token=.
 *
 *  Adres jest BEZWZGLĘDNY i to nie jest kosmetyka. Aplikacja mobilna wstrzykuje
 *  interfejs przez `loadDataWithBaseURL`: `location` udaje adres hosta, ale
 *  prawdziwym adresem dokumentu zostaje wstrzyknięta treść. `fetch("/api/...")`
 *  działa, bo idzie po `document.baseURI`; względny `src` iframe'a rozwiązuje
 *  się względem tego prawdziwego adresu i nie prowadzi donikąd. Iframe zostawał
 *  wtedy na `about:blank` — odpalał `load`, `stripVncChrome` malowało mu tło na
 *  czarno i to był cały „czarny ekran komputera": ani jednego żądania do
 *  serwera. */
/** Pochodzenie hosta, sklejane z `protocol` i `host`, nigdy z `location.origin`.
 *  W dokumencie wstrzykniętym przez `loadDataWithBaseURL` `origin` bywa napisem
 *  `"null"` (pochodzenie nieprzejrzyste), a wtedy adres iframe'a zaczyna się od
 *  `null/` i znowu jest względny. `host` zostaje poprawny — stoi na nim
 *  WebSocket czatu, który w aplikacji działa. */
export function vncOrigin(): string {
  if (typeof location === "undefined" || !location.host) return "";
  return `${location.protocol}//${location.host}`;
}

export function computerVncSrc(botId: string, controlOwner: ControlOwner, token = ""): string {
  // `vnc_lite.html`, nie `vnc.html`: pełna strona noVNC dokłada własny pasek
  // sterowania (logo, rozłącz, ustawienia), a to jest ekran komputera bota, nie
  // klient VNC — sterowanie ma UI panelu. Lite umie dokładnie to, czego
  // potrzebujemy: `path`, `scale`, `view_only`.
  const ws = `api/bots/${botId}/computer/vnc/websockify${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const base = `${vncOrigin()}/api/bots/${botId}/computer/vnc/vnc_lite.html?scale=true&path=${ws}`;
  return controlOwner === "agent" ? `${base}&view_only=1` : base;
}

/** Lite zostawia u góry pasek stanu z „Send CtrlAltDel". Strona jedzie z naszego
 *  origin (proxy harnessu), więc chowamy go stąd — zamiast utrzymywać własną
 *  kopię noVNC albo przepisywać HTML w proxy.
 *
 *  CHOWAMY, nie usuwamy, i to nie jest kosmetyka. `load` ramki potrafi paść
 *  PRZED wykonaniem modułu `vnc_lite.html` (zmierzone w Electronie: load 1189 ms,
 *  pierwszy canvas 1223 ms), a pierwsza instrukcja tego modułu to
 *  `document.getElementById('sendCtrlAltDelButton').onclick = …`. Po `remove()`
 *  guzik już nie istnieje, moduł leci na
 *  `TypeError: Cannot set properties of null` i RFB NIGDY nie powstaje: brak
 *  canvasu, brak WebSocketa, ekran komputera zostaje czarny na zawsze. */
export function stripVncChrome(doc: Document | null | undefined): void {
  const bar = doc?.getElementById("top_bar");
  if (bar) (bar as HTMLElement).style.display = "none";
  if (doc?.body) doc.body.style.backgroundColor = "#000";
}

/** noVNC rysuje kursor zdalny jako nakładkę (`.noVNC_cursor`). Gdy użytkownik
 *  odda sterowanie (`owner === "agent"`), ten kursor zostaje tam, gdzie go
 *  zostawił człowiek, i wygląda, jakby wciąż sterował — mylące. Chowamy go
 *  dokładnie w chwili oddania, nie po następnej klatce. */
const CURSOR_HIDE_ID = "__mb_vnc_cursor_hide__";
export function setRemoteCursorHidden(doc: Document | null | undefined, hidden: boolean): void {
  if (!doc) return;
  let style = doc.getElementById(CURSOR_HIDE_ID) as HTMLStyleElement | null;
  if (hidden && !style) {
    style = doc.createElement("style");
    style.id = CURSOR_HIDE_ID;
    style.textContent = "#noVNC_cursor, .noVNC_cursor { display: none !important; }";
    (doc.head || doc.documentElement).appendChild(style);
  } else if (!hidden && style) {
    style.remove();
  }
}

const POLL_MS = 4000;
// server lease (computer-control.ts LEASE_MS) is 30s; renew at a third of
// that so a slow tick never lets it lapse
const RENEW_MS = 10_000;

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [computerState, setComputerState] = useState<ComputerState>("provisioning");
  const [detail, setDetail] = useState<string | null>(null);
  const [owner, setOwner] = useState<ControlOwner>("agent");
  const [agentQueue, setAgentQueue] = useState<AgentQueue>({});
  const [controlPending, setControlPending] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const ownerRef = useRef<ControlOwner>("agent");
  ownerRef.current = owner;
  const screenRef = useRef<HTMLIFrameElement>(null);
  // Ekran, który się nie wczytał, był dotąd niemym czarnym prostokątem —
  // nie do odróżnienia od pulpitu z czarną tapetą. Diagnoza „czarny ekran
  // w aplikacji" schodziła przez to na zgadywanie. Tu iframe mówi, co mu jest.
  const [screenNote, setScreenNote] = useState<string | null>(null);
  const [screenLoaded, setScreenLoaded] = useState(false);

  // poll the harness for the container's state; ready/provisioning/
  // recovering/error only — never a user-facing "off"
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api(`/api/bots/${bot.id}/computer`)
        .then((r) => {
          if (!alive) return;
          setComputerState(r.state);
          setDetail(r.detail ?? null);
          setAgentQueue(r);
        })
        .catch((e) => {
          if (alive) {
            setComputerState("error");
            setDetail(e instanceof Error ? e.message : String(e));
          }
        });
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bot.id]);

  // sync who currently holds the input lease when the panel opens or the
  // bot changes; release it on the way out so a closed tab (or a bot
  // switch mid-takeover) can never hold the computer hostage
  useEffect(() => {
    let alive = true;
    setOwner("agent");
    api(`/api/bots/${bot.id}/computer/control`)
      .then((r) => { if (!alive) return; setOwner(r.owner); setAgentQueue(r); })
      .catch(() => {});
    const botId = bot.id;
    return () => {
      alive = false;
      if (ownerRef.current === "user") {
        void api(`/api/bots/${botId}/computer/control/release`, { method: "POST" }).catch(() => {});
      }
    };
  }, [bot.id]);

  // renew the lease on a timer while the user holds it — the lease is
  // short by design, so it must be renewed while active or it expires
  useEffect(() => {
    if (owner !== "user") return;
    const timer = setInterval(() => {
      api(`/api/bots/${bot.id}/computer/control/renew`, { method: "POST" })
        .then((r) => { setOwner(r.owner); setAgentQueue(r); })
        .catch(() => setOwner("agent"));
    }, RENEW_MS);
    return () => clearInterval(timer);
  }, [owner, bot.id]);

  // Escape closes fullscreen only — it never touches the computer itself
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Chowaj kursor zdalny dokładnie w chwili oddania sterowania — nie czekaj na
  // przeładowanie iframe'a (efekt wyżej działa tylko przy onLoad).
  useEffect(() => {
    setRemoteCursorHidden(screenRef.current?.contentDocument, owner === "agent");
  }, [owner, computerState, fullscreen]);

  // K5: faza nagrywania skilla leci z TeachCard (karta pod ekranem) jako
  // zdarzenie, żeby czerwona ramka i pasek nagrywania mogły siedzieć NA ekranie
  // komputera, a nie tylko w karcie.
  const [teachPhase, setTeachPhase] = useState<string>("idle");
  useEffect(() => {
    const onPhase = (e: Event) => setTeachPhase(((e as CustomEvent).detail as { phase: string }).phase);
    window.addEventListener("mb:teach:phase", onPhase);
    return () => window.removeEventListener("mb:teach:phase", onPhase);
  }, []);
  const teachRecording = teachPhase === "recording" || teachPhase === "stopping";

  const acquireControl = () => {
    setControlPending(true);
    api(`/api/bots/${bot.id}/computer/control/acquire`, { method: "POST" })
      .then((r) => { setOwner(r.owner); setAgentQueue(r); })
      .catch(() => {})
      .finally(() => setControlPending(false));
  };
  const releaseControl = () => {
    setControlPending(true);
    api(`/api/bots/${bot.id}/computer/control/release`, { method: "POST" })
      .then((r) => { setOwner(r.owner); setAgentQueue(r); })
      .catch(() => {})
      .finally(() => setControlPending(false));
  };

  // multibot: sterowanie i nagrywanie to dwie ikony obok siebie. Napisy poszły,
  // bo rząd wchodzi też do nagłówka pełnego ekranu, gdzie dwa pełne przyciski
  // zjadały miejsce nazwie. Stan czyta się z koloru: wypełniony = aktywne.
  const controlLabel =
    owner === "user"
      ? polish ? "Oddaj sterowanie" : "Hand back"
      : polish ? "Przejmij sterowanie" : "Take control";
  const controlButton = computerState === "ready" && (
    <button
      type="button"
      onClick={owner === "user" ? releaseControl : acquireControl}
      disabled={controlPending}
      title={controlLabel}
      aria-label={controlLabel}
      aria-pressed={owner === "user"}
      className={cn(
        "rounded-lg p-2 disabled:opacity-50",
        owner === "user" ? "bg-accent text-white" : "bg-raised text-ink-secondary hover:bg-raised-hover hover:text-ink",
      )}
    >
      {controlPending ? (
        <Loader2 size={16} className="animate-spin" />
      ) : owner === "user" ? (
        <Hand size={16} />
      ) : (
        <MousePointer2 size={16} />
      )}
    </button>
  );
  // multibot: nagrywanie startuje z ikony przy „Przejmij sterowanie", a stan
  // trzyma TeachCard pod ekranem — stąd zdarzenie zamiast wspólnego reduktora.
  // Ta sama ikona zatrzymuje, więc jeden guzik zamiast dwóch obok siebie.
  //
  // Czynny WYŁĄCZNIE w `idle` (start) i `recording` (stop): karta ignoruje start
  // w każdej innej fazie, więc w `stopped`, `synthesizing` i `done` guzik
  // wyglądał na aktywny i nie robił nic.
  const teachButton = computerState === "ready" && (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(new CustomEvent(teachRecording ? "mb:teach:stop" : "mb:teach:start"))
      }
      disabled={teachPhase !== "idle" && teachPhase !== "recording"}
      title={
        teachRecording
          ? polish ? "Zatrzymaj nagrywanie" : "Stop recording"
          : polish ? "Naucz umiejętności — nagraj demonstrację" : "Teach a skill — record a demonstration"
      }
      aria-label={
        teachRecording
          ? polish ? "Zatrzymaj nagrywanie" : "Stop recording"
          : polish ? "Naucz umiejętności" : "Teach a skill"
      }
      aria-pressed={teachRecording}
      className={cn(
        "rounded-lg p-2 disabled:opacity-50",
        teachRecording ? "bg-danger text-white" : "bg-raised text-ink-secondary hover:bg-raised-hover hover:text-ink",
      )}
    >
      {teachPhase === "starting" || teachPhase === "stopping" ? (
        <Loader2 size={16} className="animate-spin" />
      ) : teachRecording ? (
        <Square size={16} />
      ) : (
        <GraduationCap size={16} />
      )}
    </button>
  );
  const agentName = (() => {
    const found = state.bots.find((item) => item.id === agentQueue.agentOwner);
    return found ? botDisplayName(found, polish ? "pl" : "en") : agentQueue.agentOwner;
  })();
  const queuedCount = agentQueue.agentQueue?.length ?? 0;
  // H4: the iframe cannot set an Authorization header, so the bearer rides the
  // websockify path as ?token= — mobile WebView has no session cookie to lean
  // on. Desktop keeps working either way (cookie or token).
  const vncToken = getAuthToken();

  // Iframe, który nigdy nie wyśle żądania, nie odpala ani `onLoad`, ani
  // `onError` — milczy. Pasek stanu pod ekranem wisi od pierwszej klatki i
  // znika dopiero, gdy ekran realnie się wczyta, więc nieudany ekran nigdy
  // nie wygląda jak pulpit z czarną tapetą.
  useEffect(() => {
    setScreenLoaded(false);
    setScreenNote(null);
  }, [computerState, bot.id, owner, vncToken]);

  const screen = (fullscreenView: boolean) =>
    computerState === "ready" ? (
      <div className="relative h-full w-full">
        <iframe
          ref={screenRef}
          title={polish ? "Ekran bota" : "Bot screen"}
          src={computerVncSrc(bot.id, owner, vncToken)}
          onLoad={(e) => {
            // Pusty dokument startowy iframe'a też odpala `load`. Bez tego
            // rozróżnienia „ekran wczytany" znaczyło „ramka istnieje", pasek
            // znikał po mgnieniu, a `stripVncChrome` malowało `about:blank` na
            // czarno — czyli produkowało dokładnie ten czarny ekran, którego
            // szukaliśmy.
            let where = "";
            let reach = "";
            try {
              where = e.currentTarget.contentDocument?.location?.href ?? "brak-dokumentu";
            } catch (err) {
              reach = (err as Error).message;
            }
            if (reach) {
              // Sięgnięcie po dokument rzuciło. Ekran mógł się wczytać z obcego
              // pochodzenia albo WebView blokuje dostęp — tak czy owak nie da
              // się zdjąć paska noVNC ani schować kursora, więc mówimy o tym
              // wprost zamiast udawać sukces.
              setScreenNote(`Ramka niedostępna z tej strony: ${reach}`);
              return;
            }
            if (where === "about:blank" || where === "brak-dokumentu") {
              setScreenNote(`Ramka stoi na ${where}. Adres: ${vncOrigin() || "PUSTY"}`);
              return;
            }
            setScreenLoaded(true);
            try {
              stripVncChrome(e.currentTarget.contentDocument);
              setRemoteCursorHidden(e.currentTarget.contentDocument, ownerRef.current === "agent");
              setScreenNote(null);
            } catch (err) {
              setScreenNote(`Ekran wczytany, brak dostępu do jego dokumentu: ${(err as Error).message}`);
            }
          }}
          onError={() => setScreenNote("Przeglądarka nie wczytała adresu ekranu.")}
          // Do `load` ramka pokazuje niebieski pasek noVNC („Loading",
          // „Send CtrlAltDel") — chowamy go dopiero w `onLoad`, więc bez tego
          // mruga na starcie. `invisible` (visibility), nie `hidden`: noVNC
          // liczy `scaleViewport` z realnych wymiarów ramki.
          className={cn("h-full w-full border-0", !screenLoaded && "invisible")}
        />
        {(!screenLoaded || screenNote) && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 rounded-lg bg-danger px-3 py-2 text-[11px] leading-snug text-white">
            {screenNote ?? `czekam na ekran · stan: ${computerState} · token: ${vncToken ? "jest" : "BRAK"} · adres: ${vncOrigin() || "PUSTY"} · origin: ${typeof location === "undefined" ? "brak" : String(location.origin)}`}
          </div>
        )}
        {/* view-only screen: clicks land nowhere useful, so use them to expand */}
        {owner === "agent" && !fullscreenView && (
          <button
            type="button"
            aria-label={polish ? "Pełny ekran" : "Full screen"}
            onClick={() => setFullscreen(true)}
            className="absolute inset-0 cursor-zoom-in"
          />
        )}
        {/* multibot: czerwona ramka dookoła nagrywanego obszaru (UI-SPEC §8) —
            i nic poza nią. Pasek z napisem „Nagrywanie…" zasłaniał górę ekranu
            bota dokładnie wtedy, gdy użytkownik pokazuje tam zadanie; stop
            siedzi w ikonie nad ekranem, więc pasek nie niósł nic własnego.
            Osobna warstwa, nie obramowanie kontenera: `pointer-events-none`
            przepuszcza kliknięcia do ekranu, a ramka nie zabiera iframe'owi
            pikseli, więc obraz nie skacze przy starcie nagrywania. */}
        {teachRecording && (
          <div className="pointer-events-none absolute inset-0 z-20 border-2 border-danger" />
        )}
      </div>
    ) : (
      <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
        {computerState === "error" ? <AlertTriangle size={22} /> : <Loader2 size={18} className="animate-spin" />}
        <span className="text-[12px]">{computerStateLabel(computerState, polish)}</span>
        {detail && computerState !== "provisioning" && <span className="text-[11px] opacity-70">{detail}</span>}
      </div>
    );

  return (
    <>
      <SidePanel
        storageKey="multibot.panelWidth.computer"
        defaultWidth={360}
        label={polish ? "Zmień szerokość panelu komputera" : "Resize computer panel"}
        className="border-l border-hairline/40"
      >
        {/* Header */}
        <div data-shell-header className="flex items-center justify-between px-4 py-3">
          <button
            onClick={() => dispatch({ type: "toggleSettings", open: true })}
            className="inline-flex size-8 items-center justify-center rounded-md p-0 text-ink-secondary hover:bg-raised hover:text-ink"
            title={polish ? "Ustawienia bota" : "Bot settings"}
          >
            <Settings size={18} />
          </button>
          <span className="text-[15px] font-semibold text-ink">{polish ? "Komputer bota" : "Bot computer"}</span>
          <button
            onClick={() => dispatch({ type: "toggleComputer", open: false })}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 flex-col px-5 pb-5">
          {/* Zadanie 1: bot ma wiedzieć że to JEGO komputer — jedna trwała maszyna
              na workspace, wspólna dla wszystkich botów, ale każdy ma pełny dostęp.
              Banner mówi to samo użytkownikowi: to ICH komputer, z przeglądarką,
              terminalem i plikami — boty mają z niego korzystać bez pytania. */}
          <div className="mt-2 text-[12px] text-ink-secondary">
            {polish
              ? "To jest TWÓJ komputer — jeden trwały Linux na cały workspace, współdzielony przez wszystkie boty, ale każdy ma do niego pełny dostęp (przeglądarka, terminal, pliki). Boty korzystają z niego bez pytania."
              : "This is YOUR computer — one persistent Linux desktop per workspace, shared by all bots but fully yours to use (browser, terminal, files). Bots use it without asking."}
          </div>
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            {/* Znacznik wydania widoczny gołym okiem. Bez niego nie da się z
                zewnątrz odróżnić „poprawka nie działa" od „aplikacja wciąż
                chodzi na starej paczce", a to dwie zupełnie różne diagnozy. */}
            <span>{polish ? "Ekran bota" : "Bot screen"} <span className="opacity-50">d4</span></span>
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              title={polish ? "Pełny ekran" : "Full screen"}
              aria-label={polish ? "Pełny ekran" : "Full screen"}
              className="rounded-md p-1 hover:bg-raised hover:text-ink"
            >
              <Maximize2 size={14} />
            </button>
          </div>
          {(agentName || queuedCount > 0) && (
            <div className="mb-2 rounded-lg bg-raised/60 px-3 py-2 text-[12px] text-ink-secondary">
              {agentName && <div>{polish ? `Teraz prowadzi: ${agentName}` : `Now driving: ${agentName}`}</div>}
              {queuedCount > 0 && <div>{polish ? `W kolejce: ${queuedCount}` : `Queued: ${queuedCount}`}</div>}
            </div>
          )}

          {/* Ramka trzyma kształt pulpitu (16:9, scripts/computer-native.sh), zamiast
              rozpychać się na całą wysokość panelu — inaczej podgląd był wąskim paskiem
              w środku wielkiego czarnego prostokąta.
              ponytail: proporcja wpisana na sztywno; gdyby `MULTIBOT_COMPUTER_GEOMETRY`
              zaczęło się realnie zmieniać, trzeba ją podać ze stanu komputera. */}
          <div className="flex aspect-[16/9] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
            {!fullscreen && screen(false)}
          </div>

          {controlButton && (
            <div className="mt-3 flex items-center justify-end gap-2">
              {teachButton}
              {controlButton}
            </div>
          )}

          <TeachCard
            botId={bot.id}
            onSkillCreated={() => {}}
            polish={polish}
            computerReady={computerState === "ready"}
            notReadyLabel={computerStateLabel(computerState, polish)}
            onStartControl={acquireControl}
            onStopControl={releaseControl}
          />
        </div>
      </SidePanel>

      {fullscreen && (
        // K6: duży panel na środku, nie cały ekran — MultiBot pod spodem zostaje
        // widoczny (lekko przyciemnione tło), róg zaokrąglony jak w kartach.
        <div className="fixed inset-0 z-50 flex flex-col bg-black/50 p-[5%] backdrop-blur-[1px]">
          {/* multibot: same ikony, bez tytułu — na pełnym ekranie liczy się
              obraz, a nazwa panelu i tak stoi w nagłówku panelu obok. */}
          <div className="flex items-center justify-end px-1 py-2">
            <div className="flex items-center gap-2">
              {teachButton}
              {controlButton}
              <button
                onClick={() => setFullscreen(false)}
                className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-hidden">
            <div className="h-full w-full overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/10">
              {screen(true)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
