import { Loader2 } from "lucide-react";

/** Spinning ring. The one loading mark the whole interface uses. */
export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}

/** Spinner plus a label — the "Loading…" row repeated in every panel. */
export function LoadingRow({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2 px-2 py-3 text-[13px] text-ink-secondary ${className}`}>
      <Spinner /> {label}
    </div>
  );
}

/** Grey block standing in for content that has not arrived yet. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-hairline/30 ${className}`} />;
}
