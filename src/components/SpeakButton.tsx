// multibot: TTS speaker for assistant bubbles. One source of audio/mpeg:
// POST /api/bots/<botId>/speak — the harness, whenever a `ttsKey` is set. No
// key means no voice anywhere, so the button renders only once it is set.
// Button styling copies the ChatMarkdown code-block copy button; visibility is
// gated on bubble hover via the `group/msg` class added in ChatView's Bubble.
import { useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2, VolumeX } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";

type Phase = "idle" | "loading" | "playing" | "error";

// one utterance at a time — playing a second message stops the first
let live: { stop: () => void } | null = null;

export function SpeakButton({ text }: { text: string }) {
  const { state } = useStore();
  const polish = useLanguage() === "pl";
  const [phase, setPhase] = useState<Phase>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // stable identity holding the latest stop() — for `live` and unmount cleanup
  const self = useRef<{ stop: () => void }>({ stop: () => {} });

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (live === self.current) live = null;
    setPhase("idle");
  };
  self.current.stop = stop;

  useEffect(() => {
    const s = self.current;
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
      s.stop();
    };
  }, []);

  // messages render inside the selected bot's ChatView — same fallback as Shell
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];
  const harnessVoice = Boolean(state.config?.voice?.configured);
  if (!bot || !harnessVoice || !text.trim()) return null;

  const fail = () => {
    setPhase("error");
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setPhase("idle"), 2500);
  };

  const play = async () => {
    if (live && live !== self.current) live.stop();
    live = self.current;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPhase("loading");
    try {
      const res = await authFetch(`/api/bots/${encodeURIComponent(bot.id)}/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (ctl.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => self.current.stop();
      await audio.play();
      setPhase("playing");
    } catch {
      // unknown bot (404), TTS provider unreachable (502), or autoplay
      // refusal — a short error state on the button, never a crash
      if (ctl.signal.aborted) return;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
      audioRef.current = null;
      if (live === self.current) live = null;
      fail();
    }
  };

  return (
    <button
      onClick={() => (phase === "loading" || phase === "playing" ? stop() : void play())}
      className={cn(
        // multibot: bez `mt-1` i z mniejszym paddingiem — przycisk siedzi teraz
        // w jednym rzędzie ze znacznikiem czasu (stopka dymka w ChatView),
        // więc nie może dokładać własnego odstępu ani rozpychać wiersza.
        // multibot: na telefonie nie ma hovera, wiec `group-hover/msg` nigdy by nie
        // zadzialal i przycisk bylby niewidoczny - dotyk dostaje go na stale.
        "rounded p-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100",
        // multibot: ta sama jasna stylistyka co CopyMessageButton — rząd stopki
        // leży teraz na tle czatu, nie w dymku
        phase === "error" ? "text-danger" : "text-ink/85 hover:bg-raised hover:text-white",
        phase !== "idle" && "opacity-100",
      )}
      title={
        phase === "playing"
          ? polish ? "Zatrzymaj" : "Stop"
          : phase === "loading"
            ? polish ? "Ładowanie dźwięku…" : "Loading audio…"
            : phase === "error"
              ? polish ? "Synteza mowy niedostępna — czy usługa lokalna działa?" : "TTS unavailable — is the local service running?"
              : polish ? "Czytaj na głos" : "Read aloud"
      }
    >
      {/* multibot: ikony 13 → 10, proporcjonalnie do zmniejszonego dymka */}
      {phase === "loading" ? (
        <Loader2 size={13} className="animate-spin" />
      ) : phase === "playing" ? (
        <Square size={13} className="fill-current" />
      ) : phase === "error" ? (
        <VolumeX size={13} />
      ) : (
        <Volume2 size={13} />
      )}
    </button>
  );
}
