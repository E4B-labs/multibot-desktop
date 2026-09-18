import { Download } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { openFileViaShell } from "@/lib/nativeBridge";

// multibot: wspólna karta pliku — kolorowa ikona z rozszerzeniem, nazwa, pod
// nią rozmiar, po prawej strzałka pobierania. Ten sam wygląd dla załączników
// użytkownika i bota; Composer (szkic wiadomości) ma docelowo używać tej samej
// karty. Kolory wyłącznie z istniejących tokenów motywu.
const EXT_TONE: Record<string, string> = {
  MD: "bg-accent/15 text-accent",
  TXT: "bg-accent/15 text-accent",
  PDF: "bg-danger/15 text-danger",
  CSV: "bg-success/15 text-success",
  XLSX: "bg-success/15 text-success",
  ZIP: "bg-warning/15 text-warning",
  JSON: "bg-warning/15 text-warning",
};

export function formatFileSize(size: number): string {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${(Math.max(size, 1) / 1024).toFixed(1)} KB`;
}

export function AttachmentCard({
  name,
  size,
  url,
  path,
  mime,
  icon,
  action,
}: {
  name: string;
  size: number;
  url?: string | null;
  /** Ścieżka pliku na serwerze. Podana — powłoka telefonu pobiera i otwiera
   * plik sama, bo `<a download>` na blobie w Android WebView nic nie robi.
   * Szkic wiadomości jej nie ma (plik jeszcze nigdzie nie leży) i zostaje przy
   * zwykłym linku. */
  path?: string;
  mime?: string;
  /** podmienia kafelek z rozszerzeniem, np. miniaturą obrazka w szkicu */
  icon?: ReactNode;
  /** podmienia pobieranie, np. na "usuń" w szkicu wiadomości */
  action?: ReactNode;
}) {
  const dot = name.lastIndexOf(".");
  const ext = (dot > 0 ? name.slice(dot + 1, dot + 5) : "").toUpperCase();
  const isSkill = name.toLowerCase() === "skill.md";
  return (
    <div className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5", isSkill ? "bg-[#1e2a33] border border-white/[0.04]" : "bg-raised")}>
      {icon ??
        (isSkill ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#2a4a5e] text-accent">
            <span className="text-[10px] font-bold leading-none">mD</span>
          </span>
        ) : (
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg text-[10px] font-semibold",
              EXT_TONE[ext] ?? "bg-inset text-ink-secondary",
            )}
          >
            {ext || "FILE"}
          </span>
        ))}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-ink">{name}</span>
        <span className="block text-[12px] text-ink-secondary">{formatFileSize(size)}</span>
      </span>
      {action ?? (
        <a
          href={url ?? undefined}
          download={name}
          aria-disabled={!url}
          aria-label={`Download ${name}`}
          onClick={(e) => {
            if (path && openFileViaShell(path, name, mime ?? "")) e.preventDefault();
          }}
          className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised-hover hover:text-ink aria-disabled:opacity-40"
        >
          <Download size={16} />
        </a>
      )}
    </div>
  );
}
