// multibot: podgląd załącznika-obrazka w aplikacji (port z upstreamu #436).
// Portal nad całą powłoką; Escape i klik w tło zamykają, pobieranie zostaje.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { useLanguage } from "@/lib/language";

export function AttachmentPreviewDialog({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  const polish = useLanguage() === "pl";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-black/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={name}
    >
      <img
        src={url}
        alt={name}
        className="max-h-[82vh] max-w-full rounded-xl object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <span className="max-w-[50vw] truncate rounded-full bg-white/10 px-3 py-1.5 text-[12.5px] text-white/80">
          {name}
        </span>
        <a
          href={url}
          download={name}
          className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12.5px] text-white hover:bg-white/25"
        >
          <Download size={13} /> {polish ? "Pobierz" : "Download"}
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label={polish ? "Zamknij podgląd" : "Close preview"}
          className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12.5px] text-white hover:bg-white/25"
        >
          <X size={13} /> {polish ? "Zamknij" : "Close"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
