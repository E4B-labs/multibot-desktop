import { useState, type ReactNode } from "react";
import { Wand2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { useStore } from "@/state/store";

// multibot: nazwa skilla w treści wiadomości. Czarna pigułka (SkillPill) wcinała
// się w zdanie jak wklejony przycisk; skill w tekście ma być TEKSTEM — tym samym
// krojem i rozmiarem co reszta zdania, tylko w kolorze skilli, z różdżką przed
// nazwą. Najechanie (albo tab) pokazuje opis, klik otwiera panel skilli
// rozwinięty na tym skillu.
export function SkillRef({
  name,
  children,
  compact = false,
  block = false,
}: {
  name: string;
  /** Tekst z transkryptu; bez niego rysujemy samą nazwę. */
  children?: ReactNode;
  compact?: boolean;
  /** Wariant „pigułka zdarzenia": wyśrodkowana, bez ramki — sam oddech. */
  block?: boolean;
}) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [open, setOpen] = useState(false);
  const description = state.skills.find((skill) => skill.name === name)?.description?.trim();

  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => dispatch({ type: "toggleSkills", open: true, skill: name })}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        title={name}
        className={cn(
          "inline-flex items-center gap-1 font-semibold text-[#ffb700] hover:underline",
          block && "px-3 py-1",
          compact ? "text-[13px]" : "text-[12.5px]",
        )}
      >
        <Wand2 size={compact ? 12 : 11} className="shrink-0" />
        {children ?? name}
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-64 rounded-xl border border-hairline/50 bg-card p-3 text-left shadow-xl"
        >
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <Wand2 size={13} className="shrink-0 text-[#ffb700]" />
            {name}
          </span>
          <span className="mt-1 block text-[12px] leading-snug text-ink-secondary">
            {description || (polish ? "Brak opisu" : "No description")}
          </span>
          <span className="mt-1.5 block text-[12px] font-medium text-[#ffb700]">
            {polish ? "Otwórz" : "Open"}
          </span>
        </span>
      )}
    </span>
  );
}
