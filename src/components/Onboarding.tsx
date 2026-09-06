// 0.4.0: the first screen on every device is "set up a server" or "sign in to
// one". Everything the old wizard did between those two points (CLI tools,
// custom models, permissions, workspace access) already has a settings panel —
// duplicating it here only meant two places to fix.
import { useEffect, useState } from "react";
import { ArrowLeft, Copy, Eye, EyeOff, Loader2 } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { authFetch, setSessionToken, setV2AuthToken, takeJoinGrant } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { copyText, isReactNativeShell, joinLocalHarness, resolveHost } from "@/lib/shell";
import type { SetupValues } from "@/types/ogb";

const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
const inputClass = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

export type OnboardingPath = "setup" | "join";
export type OnboardingStep =
  | "choice"
  | "installing"
  | "credentials"
  | "signin"
  | "profileKind"
  | "profile"
  | "recover"
  | "working"
  | "done";

/** Both paths are straight lines, so the whole state machine is two arrays and
 * an index. Kept pure and exported because the order is the part that breaks. */
const FLOW: Record<OnboardingPath, readonly OnboardingStep[]> = {
  setup: ["choice", "installing", "credentials", "profile", "working", "done"],
  join: ["choice", "signin", "profileKind", "profile", "working", "done"],
};

export function nextStep(path: OnboardingPath, step: OnboardingStep): OnboardingStep {
  const flow = FLOW[path];
  const at = flow.indexOf(step);
  if (at < 0) return step;
  return flow[Math.min(at + 1, flow.length - 1)];
}

export function previousStep(path: OnboardingPath, step: OnboardingStep): OnboardingStep {
  // Recovery hangs off the profile screens rather than sitting in the line:
  // it is the same place in the story, reached when the password is gone.
  if (step === "recover") return path === "join" ? "signin" : "profile";
  const flow = FLOW[path];
  const at = flow.indexOf(step);
  return at <= 0 ? "choice" : flow[at - 1];
}

export type JoinErrorField = "address" | "name" | "password" | "form" | "profileName" | "profilePassword";

const ADDRESS_CODES = ["invalid_address", "unreachable", "timeout", "not_multibot", "server_not_set_up", "certificate_changed", "insecure_address"];
const PROFILE_NAME_CODES = ["invalid username", "profile_name_taken", "no_such_profile", "invalid email", "display name required"];
const PROFILE_PASSWORD_CODES = ["wrong_profile_password", "password must contain 12-128 characters", "new password must contain 12-128 characters"];

/** Which field the server just said was wrong. The whole reason sign-in and
 * registration have separate error codes is that "login failed" tells nobody
 * which value to fix. */
export function joinErrorField(code: string): JoinErrorField {
  if (code === "wrong_server_name") return "name";
  if (code === "wrong_server_password") return "password";
  if (ADDRESS_CODES.includes(code)) return "address";
  if (PROFILE_NAME_CODES.includes(code)) return "profileName";
  if (PROFILE_PASSWORD_CODES.includes(code)) return "profilePassword";
  return "form";
}

/** The exact four lines "Copy all three" puts on the clipboard. Typed into
 * another device by hand as often as pasted, so the labels are part of it. */
export function credentialsText(values: { serverName: string; address: string; serverPassword: string }): string {
  return `MultiBot server\nName: ${values.serverName}\nAddress: ${values.address}\nPassword: ${values.serverPassword}`;
}

/** What this address can and cannot do, in one sentence, or nothing when the
 * server has not told us yet (the discovery fields land with PR 3). */
export function addressNote(values: SetupValues | null, polish: boolean): string | null {
  if (!values) return null;
  if (values.portMapping?.state === "cgnat") {
    return polish
      ? "Operator chowa to urządzenie za swoim NAT-em — z zewnątrz nie da się do niego wejść. Potrzebne IPv6 albo serwer w domu."
      : "Your carrier hides this device behind its own NAT, so nothing outside can reach it. You need IPv6 or a server at home.";
  }
  if (values.addressKind === "ipv4-lan") {
    return polish ? "Ten adres działa tylko w tej sieci Wi-Fi." : "This address only works on this Wi-Fi network.";
  }
  if (values.addressVerified === false) {
    return polish ? "Nie potwierdziliśmy tego adresu z zewnątrz." : "We have not confirmed this address from outside.";
  }
  return null;
}

/** Where the working step gets its authorisation from. Pure, because the rule
 * that matters is invisible on screen: the setup path already read this
 * server's own name and password out of `setup.json`, so it joins with them and
 * nobody ever retypes a password that is on the same screen. */
export type JoinPlan =
  | { kind: "grant"; grant: string }
  | { kind: "join"; serverName: string; serverPassword: string }
  | { kind: "blocked" };

export function joinPlan(path: OnboardingPath, grant: string, values: SetupValues | null): JoinPlan {
  if (grant) return { kind: "grant", grant };
  if (path === "setup" && values?.serverName && values?.serverPassword) {
    return { kind: "join", serverName: values.serverName, serverPassword: values.serverPassword };
  }
  return { kind: "blocked" };
}

export type AuthMode = "register" | "login" | "recover";

/** Exactly what the working step sends. Pure so the things that must never
 * regress stay testable: a new profile carries its display name, recovery sends
 * its code and calls the password `newPassword`, and only a React Native shell
 * asks for a session token — an Electron WebContents keeps the cookie like any
 * browser, so asking there would put a long-lived credential in localStorage
 * for nothing. */
export function authRequest(input: {
  mode: AuthMode;
  username: string;
  displayName: string;
  password: string;
  recoveryCode: string;
  joinGrant: string;
  deviceName: string;
  native: boolean;
}): { path: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const common = { username: input.username, joinGrant: input.joinGrant, deviceName: input.deviceName };
  const headers: Record<string, string> = input.native ? { "x-multibot-client": "native" } : {};
  if (input.mode === "recover") {
    return { path: "/api/auth/recover", headers, body: { ...common, recoveryCode: input.recoveryCode, newPassword: input.password } };
  }
  return {
    path: input.mode === "register" ? "/api/auth/register" : "/api/auth/login",
    headers,
    body: { ...common, password: input.password, ...(input.mode === "register" ? { displayName: input.displayName } : {}) },
  };
}

const ERROR_TEXTS: Record<string, [string, string]> = {
  invalid_address: ["That is not an address we can open.", "To nie jest adres, który da się otworzyć."],
  unreachable: ["Nothing answered at this address.", "Pod tym adresem nic nie odpowiada."],
  timeout: ["The server did not answer in time.", "Serwer nie odpowiedział na czas."],
  not_multibot: ["Something answers here, but it is not a MultiBot server.", "Coś tu odpowiada, ale to nie jest serwer MultiBota."],
  server_not_set_up: ["That server has not been set up yet.", "Ten serwer nie jest jeszcze skonfigurowany."],
  certificate_changed: ["This server's certificate changed since the last time.", "Certyfikat tego serwera zmienił się od ostatniego razu."],
  insecure_address: ["The server password is never sent unencrypted. Use an https address.", "Hasła serwera nie wysyłamy otwartym tekstem. Użyj adresu https."],
  forbidden: ["This window can't change servers. Restart the app and try again.", "To okno nie może zmieniać serwerów. Uruchom aplikację ponownie i spróbuj jeszcze raz."],
  wrong_server_name: ["No server of that name here.", "Nie ma tu serwera o tej nazwie."],
  wrong_server_password: ["Wrong server password.", "Złe hasło serwera."],
  rate_limited: ["Too many attempts. Wait a minute and try again.", "Za dużo prób. Odczekaj minutę i spróbuj ponownie."],
  // The 429 body says this in English rather than in a code, and the profile
  // routes have their own bucket — so the profile step meets it too.
  "too many attempts": ["Too many attempts. Wait a minute and try again.", "Za dużo prób. Odczekaj minutę i spróbuj ponownie."],
  "invalid recovery credentials": ["That profile name and recovery code do not go together.", "Ta nazwa profilu i kod odzyskiwania do siebie nie pasują."],
  join_grant_invalid: ["The sign-in expired. Enter the server password again.", "Logowanie wygasło. Podaj hasło serwera jeszcze raz."],
  // Profile calls. The server's 422 messages are English sentences, not codes,
  // so they are matched verbatim — and said again here in the user's language.
  "invalid username": ["Profile name: 3-32 characters, lowercase letters, digits, dot, dash, underscore.", "Nazwa profilu: 3-32 znaki, małe litery, cyfry, kropka, myślnik, podkreślenie."],
  "invalid email": ["That email address is not valid.", "Ten adres e-mail jest niepoprawny."],
  "display name required": ["A display name is required.", "Nazwa wyświetlana jest wymagana."],
  "password must contain 12-128 characters": ["Profile password: 12 to 128 characters.", "Hasło profilu: od 12 do 128 znaków."],
  "new password must contain 12-128 characters": ["New profile password: 12 to 128 characters.", "Nowe hasło profilu: od 12 do 128 znaków."],
  profile_name_taken: ["That profile name is taken on this server.", "Ta nazwa profilu jest już zajęta na tym serwerze."],
  no_such_profile: ["No profile of that name on this server.", "Na tym serwerze nie ma profilu o tej nazwie."],
  wrong_profile_password: ["Wrong profile password.", "Złe hasło profilu."],
  "account unavailable": ["This profile has been disabled on this server.", "Ten profil został wyłączony na tym serwerze."],
};

export function joinErrorText(code: string, polish: boolean): string {
  const pair = ERROR_TEXTS[code];
  if (pair) return polish ? pair[1] : pair[0];
  // An unknown code is NOT "could not connect" — the connection may have been
  // fine and the server simply said something this build has never seen.
  return polish ? `Serwer odmówił i nie umiemy tego wyjaśnić: ${code}` : `The server refused and we cannot explain it: ${code}`;
}

function PasswordField({ value, onChange, placeholder, autoComplete, label, invalid }: { value: string; onChange: (value: string) => void; placeholder: string; autoComplete: string; label: string; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative mt-2">
      {/* Nothing intercepts the paste event and nothing masks the typed value:
          password managers and long generated passwords have to work here. */}
      <input type={show ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label} autoComplete={autoComplete} className={`${inputClass} pr-10 ${invalid ? "border-danger" : ""}`} />
      <button type="button" onClick={() => setShow((current) => !current)} aria-label={label} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-secondary hover:text-ink">
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

function CopyRow({ label, value, polish, width = "w-[74px]" }: { label: string; value: string; polish: boolean; width?: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <span className={`${width} shrink-0 text-[12px] text-ink-secondary`}>{label}</span>
      <code className="min-w-0 flex-1 select-all break-all text-[13px] text-ink">{value}</code>
      <button type="button" title={polish ? "Kopiuj" : "Copy"} aria-label={`${polish ? "Kopiuj" : "Copy"} ${label}`} onClick={() => void copyText(value)} className="shrink-0 text-ink-secondary hover:text-ink">
        <Copy size={13} />
      </button>
    </div>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const polish = useLanguage() === "pl";
  const [path, setPath] = useState<OnboardingPath>("join");
  const [step, setStep] = useState<OnboardingStep>("choice");
  const [values, setValues] = useState<SetupValues | null>(null);
  const [setupUnreadable, setSetupUnreadable] = useState(false);
  const [setupPath, setSetupPath] = useState<string | null>(null);
  const [devHint, setDevHint] = useState(false);
  const [address, setAddress] = useState(typeof location === "undefined" ? "" : location.origin);
  const [serverName, setServerName] = useState("");
  const [serverPassword, setServerPassword] = useState("");
  const [grant, setGrant] = useState("");
  const [creating, setCreating] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profilePassword, setProfilePassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // The browser is inside the server's origin, so its address is not a choice.
  const nativeShell = isElectron || isReactNativeShell();
  // In the desktop shell's remote mode this page is served by a loopback proxy
  // for SOMEBODY ELSE'S server. Everything about setting up a server on this
  // device is wrong there, starting with never entering that path by itself.
  const remoteWindow = typeof window !== "undefined" && Boolean(window.__MULTIBOT_REMOTE__);

  useEffect(() => {
    // The shell already traded name+password for a grant and reloaded us here.
    const handed = takeJoinGrant();
    if (handed) {
      setGrant(handed);
      setPath("join");
      setStep("profileKind");
      return;
    }
    let alive = true;
    void fetch("/api/public/server")
      .then((response) => response.json() as Promise<{ configured?: boolean; name?: string; setupPath?: string }>)
      .then((server) => {
        if (!alive) return;
        setSetupPath(server.setupPath ?? null);
        setServerName((current) => current || server.name || "");
        // A server nobody has claimed is one this device is meant to set up —
        // there is nothing to sign in to yet, so skip the choice entirely. Not
        // in remote mode: an unclaimed server at the OTHER end is somebody
        // else's to set up, and this device has no business reading its values.
        if (server.configured === false && !remoteWindow) {
          setPath("setup");
          setStep("credentials");
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [remoteWindow]);

  // Setup on the desktop: make sure the local harness is the active host and is
  // actually answering before asking it for the three values.
  useEffect(() => {
    if (step !== "installing") return;
    let alive = true;
    let tries = 0;
    // Switching hosts reloads the window and wipes whatever was typed. Only do
    // it when this window is NOT already on the harness of this device.
    void (async () => {
      const active = await window.ogb?.activeHostId?.().catch(() => undefined);
      if (active === "local") return;
      await window.ogb?.useLocalHost?.().catch(() => {});
    })();
    const timer = setInterval(() => {
      tries += 1;
      // Packaged Electron only shows this page once its harness is up, so a
      // server that never answers means a dev build with no `pnpm dev:server`.
      if (tries > 12) setDevHint(true);
      void fetch("/api/health")
        .then((response) => response.json() as Promise<{ app?: string }>)
        .then((body) => {
          if (!alive || body.app !== "multibot") return;
          setStep(nextStep("setup", "installing"));
        })
        .catch(() => {});
    }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [step]);

  // The generated password only exists in `setup.json`, and only until the first
  // profile claims the server. Electron main can read that file; a browser tab
  // cannot, and no amount of UI changes that.
  useEffect(() => {
    if (step !== "credentials" || values) return;
    const read = window.ogb?.setupValues;
    if (!read) return setSetupUnreadable(true);
    let alive = true;
    void read()
      .then((found) => {
        if (!alive) return;
        if (found?.serverPassword) setValues(found);
        else setSetupUnreadable(true);
      })
      .catch(() => alive && setSetupUnreadable(true));
    return () => { alive = false; };
  }, [step, values]);

  // "Copied" is a confirmation, not a state: it has to go away so the button
  // can confirm the next copy too.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const signIn = async () => {
    setBusy(true);
    setErrorCode(null);
    const result = await resolveHost(address.trim(), serverName.trim(), serverPassword);
    if (!result.ok) {
      setBusy(false);
      return setErrorCode(result.error);
    }
    // A native shell answers by reloading this page with the grant in the
    // fragment, so the spinner stays up until the page goes away — a form that
    // went idle here would look like nothing happened.
    if (result.handedOff) return;
    setBusy(false);
    setGrant(result.grant ?? "");
    setCreating(!result.hasUsers);
    // "Forgot password?" on the sign-in form still has to join first: recovery
    // spends a grant like every other profile call.
    setStep(recovering ? "recover" : nextStep("join", "signin"));
  };

  const username = profileName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  // The server's own rule (server/identity.ts): 12 characters, not 8 — a form
  // that accepts less just fails one screen later with a 422 nobody can act on.
  const mode: AuthMode = recovering ? "recover" : creating ? "register" : "login";
  const needsConfirm = mode !== "login";
  const profileReady = /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)
    && profilePassword.length >= 12
    && (!needsConfirm || profilePassword === confirm)
    && (mode !== "recover" || recoveryInput.trim().length > 0);

  const finish = async () => {
    setStep("working");
    setErrorCode(null);
    try {
      const plan = joinPlan(path, grant, values);
      if (plan.kind === "blocked") throw new Error("join_grant_invalid");
      let joinGrant = plan.kind === "grant" ? plan.grant : "";
      if (plan.kind === "join") {
        // Setup joins the harness on THIS device with the values it already
        // read — never `location.origin`, which in remote mode is a proxy for
        // somebody else's server.
        const joined = await joinLocalHarness(plan.serverName, plan.serverPassword);
        if (!joined.ok) throw new Error(joined.error);
        joinGrant = joined.grant ?? "";
      }
      const call = authRequest({
        mode,
        username,
        displayName: profileName.trim(),
        password: profilePassword,
        recoveryCode: recoveryInput.trim(),
        joinGrant,
        deviceName: navigator.userAgent.slice(0, 80),
        // Electron keeps the HttpOnly cookie; only a React Native WebView cannot.
        native: isReactNativeShell(),
      });
      const response = await authFetch(call.path, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) });
      const result = (await response.json().catch(() => ({}))) as { accessToken?: string; sessionToken?: string; recoveryCode?: string; error?: string };
      if (!response.ok || !result.accessToken) throw new Error(result.error ?? `auth_failed_${response.status}`);
      setV2AuthToken(result.accessToken);
      // A native WebView cannot keep the session cookie, so without this a lost
      // access token is a logout instead of a refresh.
      if (result.sessionToken) setSessionToken(result.sessionToken);
      setStep("done");
      // The recovery code is shown once and never again. Hand it over on a
      // screen the person can copy from and dismiss themselves.
      if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
      else onDone();
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      setErrorCode(code);
      // Only a spent grant needs a new one; a wrong profile password belongs on
      // the form that asked for it, not three screens back.
      const spentGrant = code === "join_grant_invalid";
      setStep(spentGrant && path === "join" ? "signin" : recovering ? "recover" : "profile");
    }
  };

  const field = (which: JoinErrorField) => (errorCode && joinErrorField(errorCode) === which ? "border-danger" : "");
  const note = addressNote(values, polish);
  const goBack = () => {
    setErrorCode(null);
    const previous = previousStep(path, step);
    // `installing` only exists in the desktop shell; a browser walking back
    // from the three values has the choice screen behind it.
    setStep(previous === "installing" && !isElectron ? "choice" : previous);
  };
  const backLink = (
    <button type="button" onClick={goBack} aria-label={polish ? "Wstecz" : "Back"} className="mb-5 flex w-fit items-center gap-1.5 text-[13px] text-ink-secondary hover:text-ink">
      <ArrowLeft size={16} />{polish ? "Wstecz" : "Back"}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-app py-6">
      <div role="dialog" aria-modal="true" aria-label={polish ? "Konfiguracja MultiBota" : "MultiBot setup"} className="mx-4 flex w-full max-w-[460px] flex-col rounded-2xl border border-hairline/40 bg-panel p-8">
        {["credentials", "signin", "profileKind", "profile", "recover"].includes(step) && backLink}

        {step === "choice" && (
          <div className="flex flex-col">
            <MausAvatar color="green" state="happy" size={72} animated={false} />
            <h1 className="mt-4 text-[20px] font-semibold text-ink">MultiBot</h1>
            <p className="mt-1.5 text-[14px] text-ink-secondary">{polish ? "Zacznij od jednej z dwóch rzeczy." : "Start with one of two things."}</p>
            <button onClick={() => { setPath("setup"); setStep(isElectron ? nextStep("setup", "choice") : "credentials"); }} className="mt-6 rounded-xl bg-raised p-4 text-left text-ink hover:bg-raised-hover">
              <div className="font-semibold">{polish ? "Postaw serwer" : "Set up a server"}</div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">{polish ? "To urządzenie będzie serwerem. Tutaj mieszkają boty i ich pamięć." : "This device will be the server. Bots and their memory live here."}</div>
            </button>
            <button onClick={() => { setPath("join"); setStep(nextStep("join", "choice")); }} className="mt-3 rounded-xl bg-raised p-4 text-left text-ink hover:bg-raised-hover">
              <div className="font-semibold">{polish ? "Zaloguj się do serwera" : "Sign in to a server"}</div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">{polish ? "Serwer już gdzieś stoi. To urządzenie tylko się do niego łączy." : "A server already exists somewhere. This device only connects to it."}</div>
            </button>
            {/* Desktop escape hatch: a saved host that stopped answering leaves
                this screen with nowhere to go otherwise. */}
            {window.ogb?.showHostPicker && (
              <button type="button" onClick={() => void window.ogb?.showHostPicker?.()} className="mt-4 text-[12px] text-ink-secondary hover:text-ink">
                {polish ? "Zapisane serwery" : "Saved servers"}
              </button>
            )}
          </div>
        )}

        {step === "installing" && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">{polish ? "Uruchamiam serwer" : "Starting the server"}</h1>
            <div className="mt-4 flex items-center gap-2 text-[13.5px] text-ink-secondary">
              <Loader2 size={16} className="animate-spin" />
              {polish ? "Czekam, aż serwer odpowie…" : "Waiting for the server to answer…"}
            </div>
            {devHint && (
              <div className="mt-3 rounded-xl bg-inset p-3 text-[12.5px] leading-relaxed text-ink-secondary">
                {polish ? "Serwer nie odpowiada. W wersji deweloperskiej uruchom go sam:" : "The server is not answering. In a development build, start it yourself:"}{" "}
                <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
              </div>
            )}
          </div>
        )}

        {step === "credentials" && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">{polish ? "Trzy wartości tego serwera" : "This server's three values"}</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">{polish ? "Wpisz je w MultiBocie na dowolnym innym urządzeniu, żeby się do tego serwera zalogować." : "Type them into MultiBot on any other device to sign in to this server."}</p>
            {values ? (
              <>
                <CopyRow label={polish ? "Nazwa" : "Name"} value={values.serverName} polish={polish} />
                <CopyRow label={polish ? "Adres" : "Address"} value={values.address} polish={polish} />
                <CopyRow label={polish ? "Hasło" : "Password"} value={values.serverPassword} polish={polish} />
                {note && <div className="mt-2 rounded-lg bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">{note}</div>}
                {values.tlsFingerprint && (
                  <div className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
                    {polish ? "Przeglądarka pokaże ostrzeżenie o certyfikacie — potwierdź raz i sprawdź odcisk:" : "A browser will warn about the certificate — accept it once, and check the fingerprint:"}
                    <code className="ml-1 select-all break-all text-ink">{values.tlsFingerprint}</code>
                  </div>
                )}
                <button onClick={() => void copyText(credentialsText(values)).then(setCopied)} className="mt-4 w-full rounded-lg bg-raised py-2.5 text-[14px] text-ink hover:bg-raised-hover">
                  {copied ? (polish ? "Skopiowane" : "Copied") : polish ? "Kopiuj wszystkie trzy" : "Copy all three"}
                </button>
                <button onClick={() => { setCreating(true); setStep(nextStep("setup", "credentials")); }} className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">
                  {polish ? "Dalej — utwórz swój profil" : "Continue — create your profile"}
                </button>
              </>
            ) : setupUnreadable ? (
              <>
                <div className="mt-4 rounded-xl bg-inset p-3 text-[12.5px] leading-relaxed text-ink-secondary">
                  {polish
                    ? "Hasło serwera istnieje w jawnej postaci tylko w pliku setup.json na urządzeniu serwera — przeglądarka nie ma jak go przeczytać. Otwórz tam ten plik i przepisz z niego nazwę i hasło."
                    : "The server password only exists in the clear in setup.json on the server device — a browser tab has no way to read a file. Open it there and copy the name and password out of it."}
                  <code className="mt-1 block select-all break-all text-ink">{setupPath ?? (polish ? "katalog danych MultiBota (~/.openmausbot)" : "the MultiBot data folder (~/.openmausbot)")}</code>
                </div>
                <button onClick={() => { setPath("join"); setStep("signin"); }} className="mt-4 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">
                  {polish ? "Mam te wartości — zaloguj się" : "I have those values — sign in"}
                </button>
              </>
            ) : (
              <div className="mt-5 flex items-center gap-2 text-ink-secondary"><Loader2 size={16} className="animate-spin" /> {polish ? "Czytanie…" : "Reading…"}</div>
            )}
          </div>
        )}

        {step === "signin" && (
          <form className="flex flex-col" onSubmit={(event) => { event.preventDefault(); void signIn(); }}>
            <h1 className="text-[18px] font-semibold text-ink">{polish ? "Zaloguj się do serwera" : "Sign in to a server"}</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">{polish ? "Trzy wartości z urządzenia, na którym stoi serwer." : "The three values from the device running the server."}</p>
            <input value={address} onChange={(event) => setAddress(event.target.value)} readOnly={!nativeShell} placeholder="https://192.168.1.42:8799" aria-label={polish ? "Adres serwera" : "Server address"} className={`mt-4 ${inputClass} ${field("address")} ${nativeShell ? "" : "opacity-60"}`} />
            <input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder={polish ? "Nazwa serwera" : "Server name"} aria-label={polish ? "Nazwa serwera" : "Server name"} className={`mt-2 ${inputClass} ${field("name")}`} />
            <PasswordField value={serverPassword} onChange={setServerPassword} placeholder={polish ? "Hasło serwera" : "Server password"} autoComplete="off" label={polish ? "Hasło serwera" : "Server password"} invalid={Boolean(field("password"))} />
            {errorCode && <div role="alert" className="mt-2 text-[12px] text-danger">{joinErrorText(errorCode, polish)}</div>}
            {errorCode === "certificate_changed" && window.ogb?.forgetHostCertificate && (
              <button type="button" onClick={() => void window.ogb?.forgetHostCertificate?.(address.trim()).then(() => void signIn())} className="mt-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover">
                {polish ? "Zaufaj nowemu certyfikatowi" : "Trust the new certificate"}
              </button>
            )}
            <button type="submit" disabled={busy} className="mt-4 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40">
              {busy ? (polish ? "Łączenie…" : "Connecting…") : polish ? "Połącz" : "Connect"}
            </button>
            {/* Recovery spends a grant like any profile call, so it still has to
                connect first — this only remembers where to go next. */}
            <button type="button" onClick={() => setRecovering(true)} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
              {recovering
                ? polish ? "Po połączeniu: odzyskiwanie hasła" : "After connecting: recover your password"
                : polish ? "Nie pamiętam hasła profilu — mam kod odzyskiwania" : "Forgot your profile password? Use a recovery code"}
            </button>
          </form>
        )}

        {step === "profileKind" && (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">{polish ? "Twój profil na tym serwerze" : "Your profile on this server"}</h1>
            <button onClick={() => { setCreating(true); setStep(nextStep("join", "profileKind")); }} className="mt-5 rounded-xl bg-raised p-4 text-left text-ink hover:bg-raised-hover">
              <div className="font-semibold">{polish ? "Nowy profil" : "New profile"}</div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">{polish ? "Pierwszy raz na tym serwerze." : "First time on this server."}</div>
            </button>
            <button onClick={() => { setCreating(false); setStep(nextStep("join", "profileKind")); }} className="mt-3 rounded-xl bg-raised p-4 text-left text-ink hover:bg-raised-hover">
              <div className="font-semibold">{polish ? "Mam już profil" : "I already have a profile"}</div>
              <div className="mt-1 text-[12.5px] text-ink-secondary">{polish ? "Zaloguj się nazwą i hasłem profilu." : "Sign in with your profile name and password."}</div>
            </button>
          </div>
        )}

        {step === "profile" && (
          <form className="flex flex-col" onSubmit={(event) => { event.preventDefault(); if (profileReady) void finish(); }}>
            <h1 className="text-[18px] font-semibold text-ink">{creating ? (polish ? "Utwórz profil" : "Create your profile") : polish ? "Zaloguj się na profil" : "Sign in to your profile"}</h1>
            <p className="mt-1 text-[13.5px] text-ink-secondary">{polish ? "Ten profil podpisuje Twoje wiadomości w workspace." : "This profile labels your messages in the workspace."}</p>
            <input autoFocus value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={polish ? "Nazwa profilu" : "Profile name"} aria-label={polish ? "Nazwa profilu" : "Profile name"} autoComplete="username" className={`mt-4 ${inputClass} ${field("profileName")}`} />
            <PasswordField value={profilePassword} onChange={setProfilePassword} placeholder={polish ? "Hasło profilu" : "Profile password"} autoComplete={creating ? "new-password" : "current-password"} label={polish ? "Hasło profilu" : "Profile password"} invalid={Boolean(field("profilePassword"))} />
            {creating && <PasswordField value={confirm} onChange={setConfirm} placeholder={polish ? "Powtórz hasło" : "Repeat password"} autoComplete="new-password" label={polish ? "Powtórz hasło" : "Repeat password"} />}
            {creating && confirm.length > 0 && profilePassword !== confirm && <div className="mt-2 text-[12px] text-danger">{polish ? "Hasła nie są takie same" : "Passwords don't match"}</div>}
            {profilePassword.length > 0 && profilePassword.length < 12 && <div className="mt-2 text-[12px] text-ink-secondary">{polish ? "Hasło profilu: co najmniej 12 znaków." : "Profile password: at least 12 characters."}</div>}
            {profileName.trim().length > 0 && !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) && <div className="mt-2 text-[12px] text-ink-secondary">{polish ? "Nazwa profilu: 3-32 znaki, litery, cyfry, kropka, myślnik." : "Profile name: 3-32 characters, letters, digits, dot, dash."}</div>}
            {errorCode && <div role="alert" className="mt-2 text-[12px] text-danger">{joinErrorText(errorCode, polish)}</div>}
            <button type="submit" disabled={!profileReady} className="mt-4 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40">
              {creating ? (polish ? "Utwórz profil" : "Create profile") : polish ? "Zaloguj się" : "Sign in"}
            </button>
            {!creating && (
              <button type="button" onClick={() => { setRecovering(true); setErrorCode(null); setStep("recover"); }} className="mt-3 text-[12px] text-ink-secondary hover:text-ink">
                {polish ? "Nie pamiętam hasła profilu — mam kod odzyskiwania" : "Forgot your profile password? Use a recovery code"}
              </button>
            )}
          </form>
        )}

        {step === "recover" && (
          <form className="flex flex-col" onSubmit={(event) => { event.preventDefault(); if (profileReady) void finish(); }}>
            <h1 className="text-[18px] font-semibold text-ink">{polish ? "Odzyskaj profil" : "Recover your profile"}</h1>
            <p className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">
              {polish
                ? "Kod odzyskiwania dostałeś przy zakładaniu profilu — albo od właściciela serwera, jeśli zresetował Ci hasło. Jest jednorazowy: po użyciu dostaniesz nowy."
                : "Your recovery code came with the profile — or from the server owner, if they reset your password. It works once; you get a new one afterwards."}
            </p>
            <input autoFocus value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={polish ? "Nazwa profilu" : "Profile name"} aria-label={polish ? "Nazwa profilu" : "Profile name"} autoComplete="username" className={`mt-4 ${inputClass} ${field("profileName")}`} />
            <input value={recoveryInput} onChange={(event) => setRecoveryInput(event.target.value)} placeholder={polish ? "Kod odzyskiwania" : "Recovery code"} aria-label={polish ? "Kod odzyskiwania" : "Recovery code"} autoComplete="one-time-code" className={`mt-2 ${inputClass}`} />
            <PasswordField value={profilePassword} onChange={setProfilePassword} placeholder={polish ? "Nowe hasło profilu" : "New profile password"} autoComplete="new-password" label={polish ? "Nowe hasło profilu" : "New profile password"} invalid={Boolean(field("profilePassword"))} />
            <PasswordField value={confirm} onChange={setConfirm} placeholder={polish ? "Powtórz nowe hasło" : "Repeat the new password"} autoComplete="new-password" label={polish ? "Powtórz nowe hasło" : "Repeat the new password"} />
            {confirm.length > 0 && profilePassword !== confirm && <div className="mt-2 text-[12px] text-danger">{polish ? "Hasła nie są takie same" : "Passwords don't match"}</div>}
            {profilePassword.length > 0 && profilePassword.length < 12 && <div className="mt-2 text-[12px] text-ink-secondary">{polish ? "Hasło profilu: co najmniej 12 znaków." : "Profile password: at least 12 characters."}</div>}
            {errorCode && <div role="alert" className="mt-2 text-[12px] text-danger">{joinErrorText(errorCode, polish)}</div>}
            <button type="submit" disabled={!profileReady} className="mt-4 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40">
              {polish ? "Ustaw nowe hasło" : "Set the new password"}
            </button>
          </form>
        )}

        {step === "working" && (
          <div className="flex flex-col items-center gap-3 py-6 text-ink-secondary">
            <Loader2 size={20} className="animate-spin" />
            <div className="text-[14px]">{polish ? "Zakładam profil na serwerze…" : "Setting up your profile on the server…"}</div>
          </div>
        )}

        {step === "done" && (recoveryCode ? (
          <div className="flex flex-col">
            <h1 className="text-[18px] font-semibold text-ink">{polish ? "Zapisz kod odzyskiwania" : "Save your recovery code"}</h1>
            <p className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">
              {polish
                ? "Pokazujemy go raz i nie da się go odczytać ponownie. Bez niego zapomniane hasło resetuje wyłącznie właściciel serwera."
                : "It is shown once and cannot be read again. Without it, a forgotten password can only be reset by the server owner."}
            </p>
            <CopyRow label={polish ? "Kod" : "Code"} value={recoveryCode} polish={polish} width="w-[44px]" />
            <button onClick={() => void copyText(recoveryCode).then(setCopied)} className="mt-3 w-full rounded-lg bg-raised py-2.5 text-[14px] text-ink hover:bg-raised-hover">
              {copied ? (polish ? "Skopiowane" : "Copied") : polish ? "Kopiuj kod" : "Copy the code"}
            </button>
            <button onClick={onDone} className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white">
              {polish ? "Zapisałem go" : "I saved it"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-ink-secondary">
            <Loader2 size={20} className="animate-spin" />
            <div className="text-[14px]">{polish ? "Wchodzę…" : "Signing you in…"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
