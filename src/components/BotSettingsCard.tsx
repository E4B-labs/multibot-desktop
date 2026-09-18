// multibot: karta „Bot" w Ustawieniach → Ogólne. Dwie rzeczy, które dotyczą
// tego, JAK bot pracuje, a nie jak wygląda aplikacja:
//   • strefa czasowa — bot dostaje ją w prompcie, więc „jutro o 9" znaczy
//     dziewiątą tam, gdzie pracujesz,
//   • Autoweryfikacja — czy każda akcja ma być sprawdzona przed uruchomieniem.
//
// Stan trzyma serwer (`PUT /api/config`), nie przeglądarka: decyzja „przepuścić
// czy zapytać" zapada w harnessie w chwili, gdy bot prosi o zgodę, więc musi ją
// widzieć serwer, a nie karta ustawień.
//
// multibot: edytor „Reguł Autoweryfikacji" wyleciał z UI (wrzesień 2026) —
// pole `autoVerify.rules` w danych i serwerze zostaje nietknięte, znika
// tylko formularz i lista w tej karcie.
import { useState } from "react";
import { Check } from "lucide-react";
import { useStore } from "@/state/store";
import { authFetch } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { AUTO_TIMEZONE } from "@/lib/timezone";
import { TimeZonePicker } from "./TimeZonePicker";
import { DEFAULT_AUTO_VERIFY, type AutoVerifySettings } from "@/lib/autoVerifyTypes";
import { Spinner } from "./Loading";

export function BotSettingsCard({ polish }: { polish: boolean }) {
  const { state, dispatch } = useStore();
  const timeZone = state.config?.timeZone ?? AUTO_TIMEZONE;
  const autoVerify = state.config?.autoVerify ?? DEFAULT_AUTO_VERIFY;

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
              ? "MultiBot sprawdza każdą akcję przed jej uruchomieniem i w razie potrzeby najpierw pyta Ciebie."
              : "MultiBot checks every action before running it and asks you first when needed."}
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
    </div>
  );
}
