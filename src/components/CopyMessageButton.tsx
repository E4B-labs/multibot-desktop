// multibot: „kopiuj" w stopce dymka bota — ten sam rząd co SpeakButton, ten
// sam wygląd co przycisk kopiowania w bloku kodu (ChatMarkdown). Kopiuje
// ŹRÓDŁO wiadomości, czyli markdown z LaTeX-em, a nie wyrenderowany tekst:
// wklejone gdzie indziej ma dać się znowu wyrenderować.
//
// Widoczność jest sterowana tak jak w SpeakButton: hover na dymku
// (`group/msg` z ChatView), a na dotyku — na stałe, bo hovera tam nie ma.
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";

export function CopyMessageButton({ text }: { text: string }) {
  const polish = useLanguage() === "pl";
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (!text.trim()) return null;

  const copy = () => {
    // brak schowka (stary WebView, kontekst bez uprawnień) nie może wywalić
    // renderu wiadomości — po cichu nic się nie dzieje
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      onClick={copy}
      className={cn(
        "rounded p-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100",
        copied ? "text-success opacity-100" : "text-ink-secondary hover:bg-raised hover:text-ink",
      )}
      title={polish ? "Kopiuj wiadomość" : "Copy message"}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
