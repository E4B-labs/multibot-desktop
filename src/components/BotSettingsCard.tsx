// multibot: karta „Bot" w Ustawieniach → Ogólne. Dwie rzeczy, które dotyczą
// tego, JAK bot pracuje, a nie jak wygląda aplikacja:
//   • strefa czasowa — bot dostaje ją w prompcie, więc „jutro o 9" znaczy
//     dziewiątą tam, gdzie pracujesz,
//   • Autoweryfikacja — czy każda akcja ma być sprawdzona przed uruchomieniem,
//     plus reguły, które przepuszczają wybrane akcje bez pytania.
//
// Stan trzyma serwer (`PUT /api/config`), nie przeglądarka: decyzja „przepuścić
// czy zapytać" zapada w harnessie w chwili, gdy bot prosi o zgodę, więc musi ją
// widzieć serwer, a nie karta ustawień.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Trash2 } from "lucide-react";
import { useStore } from "@/state/store";
import { authFetch } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { AUTO_TIMEZONE } from "@/lib/timezone";
import { TimeZonePicker } from "./TimeZonePicker";
import {
  DEFAULT_AUTO_VERIFY,
  type AutoVerifyDecision,
  type AutoVerifyRule,
  type AutoVerifySettings,
} from "@/lib/autoVerifyTypes";
import { Skeleton, Spinner } from "./Loading";

/** Rozwijane „Powinien:" — dwie pozycje z ptaszkiem przy wybranej. Natywny
 *  `<select>` nie pokazałby ptaszka, a to on mówi, co jest ustawione. */
function DecisionSelect({
  value,
  onChange,
  polish,
}: {
  value: AutoVerifyDecision;
  onChange: (decision: AutoVerifyDecision) => void;
  polish: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const labels: Record<AutoVerifyDecision, string> = {
    allow: polish ? "Zezwalaj automatycznie" : "Allow automatically",
    ask: polish ? "Najpierw pytaj" : "Ask first",
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink hover:bg-raised/40 focus:outline-none"
      >
        <span>{labels[value]}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-secondary" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1.5 w-56 overflow-hidden rounded-xl border border-hairline/40 bg-card p-1.5 shadow-lg"
        >
          {(["allow", "ask"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
            >
              <span className="flex-1">{labels[option]}</span>
              <Check size={14} className={cn("shrink-0", option === value ? "opacity-100" : "opacity-0")} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BotSettingsCard({ polish }: { polish: boolean }) {
  const { state, dispatch } = useStore();
  const timeZone = state.config?.timeZone ?? AUTO_TIMEZONE;
  const autoVerify = state.config?.autoVerify ?? DEFAULT_AUTO_VERIFY;

  const [draft, setDraft] = useState("");
  // Nowa reguła startuje na „Najpierw pytaj" (Kacper 29.08). Domyślna wartość
  // pola jest tą, którą klika się bez zastanowienia, więc ma prowadzić do
  // pytania, a nie do cichej zgody — poluzować regułę użytkownik może zawsze,
  // cofnąć akcję, która już poszła, nie zawsze.
  const [draftDecision, setDraftDecision] = useState<AutoVerifyDecision>("ask");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  /** Każda zmiana leci od razu na serwer; odpowiedź jest pełną konfiguracją,
   *  więc karta zawsze pokazuje to, co naprawdę zapisano. */
  const save = (patch: { timeZone?: string; autoVerify?: AutoVerifySettings }) => {
    setSaveState("saving");
    void authFetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then((r) => r.json())
      .then((config) => {
        dispatch({ type: "configStatus", config });
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1500);
      })
      .catch(() => setSaveState("idle"));
  };

  const setRules = (rules: AutoVerifyRule[]) => save({ autoVerify: { ...autoVerify, rules } });

  const addRule = () => {
    const when = draft.trim();
    if (!when) return;
    const rule: AutoVerifyRule = {
      id: `${Date.now().toString(36)}-${autoVerify.rules.length}`,
      when,
      decision: draftDecision,
    };
    setRules([...autoVerify.rules, rule]);
    setDraft("");
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="text-[15px] font-medium text-ink">Bot</div>
        {saveState === "saving" && <Spinner size={13} className="text-ink-secondary" />}
        {saveState === "saved" && <Check size={14} className="text-ink-secondary" />}
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div className="text-[15px] font-medium text-ink">{polish ? "Strefa czasowa" : "Time zone"}</div>
        <TimeZonePicker value={timeZone} onChange={(zone) => save({ timeZone: zone })} polish={polish} />
      </div>

      <div className="mt-4 flex items-start justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{polish ? "Autoweryfikacja" : "Auto-verification"}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {polish
              ? "MultiBot sprawdza każdą akcję przed jej uruchomieniem i w razie potrzeby najpierw pyta Ciebie. Dodaj reguły, aby dostosować, co może robić automatycznie."
              : "MultiBot checks every action before running it and asks you first when needed. Add rules to tune what it may do on its own."}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoVerify.enabled}
          aria-label={polish ? "Autoweryfikacja" : "Auto-verification"}
          onClick={() => save({ autoVerify: { ...autoVerify, enabled: !autoVerify.enabled } })}
          className={cn(
            "relative mt-1 h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
            autoVerify.enabled ? "bg-accent" : "bg-raised",
          )}
        >
          <span
            className={cn(
              "absolute top-[3px] size-5 rounded-full bg-white transition-[left]",
              autoVerify.enabled ? "left-[21px]" : "left-[3px]",
            )}
          />
        </button>
      </div>

      <div className="mt-4 border-t border-hairline/40 pt-4">
        <div className="text-[15px] font-medium text-ink">
          {polish ? "Reguły Autoweryfikacji" : "Auto-verification rules"}
        </div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {polish
            ? "Napisz jedną krótką, naturalną regułę dla każdej akcji. Przy konflikcie reguł pierwszeństwo ma „Najpierw pytaj”."
            : "Write one short, natural rule per action. When rules conflict, “Ask first” wins."}
        </div>

        {!state.config && (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-[46px]" />
            <Skeleton className="h-[46px]" />
          </div>
        )}

        {autoVerify.rules.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {autoVerify.rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between gap-3 rounded-lg bg-inset px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{rule.when}</div>
                  <div className="truncate text-[11px] text-ink-secondary">
                    {rule.decision === "allow"
                      ? polish
                        ? "Zezwalaj automatycznie"
                        : "Allow automatically"
                      : polish
                        ? "Najpierw pytaj"
                        : "Ask first"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRules(autoVerify.rules.filter((item) => item.id !== rule.id))}
                  aria-label={polish ? "Usuń regułę" : "Remove rule"}
                  className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 text-[13px] text-ink-secondary">
          {polish ? "Gdy MultiBot chce:" : "When MultiBot wants to:"}
        </div>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addRule();
            }
          }}
          placeholder={polish ? "np. odpowiadaj za mnie na e-maile" : "e.g. reply to emails for me"}
          className={cn(inputClass, "mt-1.5")}
        />

        <div className="mt-3 text-[13px] text-ink-secondary">{polish ? "Powinien:" : "It should:"}</div>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <DecisionSelect value={draftDecision} onChange={setDraftDecision} polish={polish} />
          <button
            type="button"
            onClick={addRule}
            disabled={!draft.trim()}
            className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
          >
            {polish ? "Dodaj regułę" : "Add rule"}
          </button>
        </div>

        <div className="mt-3 text-[13px] text-ink-secondary">
          {polish ? "Te reguły dotyczą tylko Ciebie." : "These rules apply to you only."}
        </div>
      </div>
    </div>
  );
}
