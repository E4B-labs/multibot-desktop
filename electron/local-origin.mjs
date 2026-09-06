// Origin gate for IPC handlers that touch this machine directly (screen
// capture, microphone, installing an update, switching hosts). Safe when the
// window shows our own local harness or a bundled file:// page; unsafe when it
// shows an arbitrary remote host (C2 remote mode) — that page, or a MITM on the
// plain http:// that normalizeRemoteUrl still accepts, must not be able to
// trigger ogb.screenFrame()/speechStart()/updater.download()/install() just
// by being loaded in the window.
//
// 127.0.0.1 obejmuje też port proxy trybu zdalnego (electron/remote-ui.mjs), a
// tam część odpowiedzi pochodzi z hosta. Dlatego proxy nie oddaje ŻADNEGO HTML-a
// spoza `/api` — jedyny ekran, jaki to okno renderuje, przychodzi z paczki. Bez
// tamtej zapory ta bramka przepuszczałaby stronę napisaną przez hosta.
export function isLocalSender(event) {
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === "file:" || url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}
