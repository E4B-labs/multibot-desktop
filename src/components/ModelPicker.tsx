// Model picker: an instance rail + model list, backed by /api/instances.
// Routing is by exact instanceId only — an entry is never inferred from a
// driver kind, and unavailable instances render disabled with the reason.
// An installed but signed-out CLI is dimmed with a shortcut to App Settings —
// see lib/instanceGate.ts.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, KeyRound, Loader2 } from "lucide-react";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { groupOpenCodeModels, isFreeModel, modelLabel } from "@/lib/opencodeModels";
import { instanceGate } from "@/lib/instanceGate";

// Nagłówkowa pigułka nigdy nie pokazuje surowego id: gdy katalog nie podał
// `name` (fallbacki go nie mają), zostaje czytelny człon po ukośniku.
function instanceModelLabel(instance: InstanceInfo | undefined, model: string): string {
  return modelLabel(model, instance?.models.options.find((o) => o.id === model)?.label);
}

/** `compact` = sama ikona dostawcy, bez nazwy modelu (Kacper 29.08). Tak stoi
 *  pigułka w nagłówku czatu, gdzie kolumna bywa wąska; w panelu ustawień bota
 *  zostaje wersja z podpisem, bo tam nazwa modelu jest treścią, nie ozdobą. */
export function ModelPicker({ bot, className, compact }: { bot: Bot; className?: string; compact?: boolean }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [pendingGoModel, setPendingGoModel] = useState<string | null>(null);
  const [expandedOpenCodeGroups, setExpandedOpenCodeGroups] = useState({ go: true, zen: true });
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((i) => i.instanceId === selection.instanceId);
  const visibleInstances = state.instances;
  const railInstance =
    visibleInstances.find((i) => i.instanceId === (railId ?? selection.instanceId)) ?? visibleInstances[0];
  const activeLabel = active
    ? `${active.displayName} · ${instanceModelLabel(active, selection.model)}`
    : instanceModelLabel(active, selection.model);
  const opencodeKeyMissing = state.config?.opencode?.configured !== true;
  const signInHint = polish
    ? "CLI jest zainstalowany, ale niezalogowany — zaloguj w Ustawieniach aplikacji"
    : "CLI is installed but signed out — sign in from App Settings";
  const railGate = railInstance ? instanceGate(railInstance.snapshot, railInstance.instanceId) : "ok";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (instance: InstanceInfo, model: string) => {
    if (instance.instanceId === "opencode" && model.startsWith("opencode-go/") && opencodeKeyMissing) {
      setPendingGoModel(model);
      setExpandedOpenCodeGroups((current) => ({ ...current, go: true }));
      return;
    }
    dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: instance.instanceId, model } });
    setPendingGoModel(null);
    setOpen(false);
  };

  const badge = (text: string) => (
    <span className="shrink-0 rounded bg-inset px-1 py-px text-[10px] text-ink-secondary">{text}</span>
  );

  // Jeden kształt wiersza dla obu gałęzi (OpenCode w grupach i reszta), żeby
  // odznaki i powód niedostępności nie rozjechały się między nimi.
  const modelRow = (
    instance: InstanceInfo,
    option: { id: string; label: string },
    opts: { indent?: boolean; needsKey?: boolean } = {},
  ) => {
    const current = selection.instanceId === instance.instanceId && selection.model === option.id;
    const gate = instanceGate(instance.snapshot, instance.instanceId);
    const disabled = gate === "missing";
    const keyHint = polish ? "wymaga wspólnego klucza OpenCode Go" : "needs the shared OpenCode Go key";
    const dimmed = gate === "signin" || Boolean(opts.needsKey);
    const hint = gate === "signin" ? signInHint : opts.needsKey ? keyHint : undefined;
    return (
      <button
        key={option.id}
        disabled={disabled}
        // Powód siedzi na całym wierszu, nie tylko na ikonce — 12 px kłódki to
        // za mały cel dla myszy i nic dla klawiatury.
        title={disabled ? (instance.snapshot.reason ?? undefined) : hint}
        onClick={() => pick(instance, option.id)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
          opts.indent && "pl-6",
          disabled ? "cursor-not-allowed text-ink-secondary/50" : "text-ink hover:bg-raised/60",
          // brak klucza ani brak logowania nie blokuje wiersza, tylko go przygasza —
          // klik otwiera pole klucza, a logowanie może wejść bez restartu pickera
          !disabled && dimmed && "opacity-60",
          current && "bg-raised",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{modelLabel(option.id, option.label)}</span>
          {option.id === instance.models.default && badge(polish ? "domyślny" : "default")}
          {isFreeModel(option.id) && badge(polish ? "darmowy" : "free")}
          {hint && (
            <span className="shrink-0 text-ink-secondary" role="img" aria-label={hint} title={hint}>
              <KeyRound size={12} aria-hidden />
            </span>
          )}
        </span>
        {current && <Check size={14} className="shrink-0 text-accent" />}
      </button>
    );
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
          onClick={() => {
            setRailId(selection.instanceId);
            setOpen((o) => {
              if (o) setPendingGoModel(null);
              return !o;
            });
          }}
        className={cn(
          "flex items-center rounded-full border border-hairline/40 bg-raised/60 text-[13px] text-ink hover:bg-raised",
          compact ? "gap-1 px-1.5 py-1" : "gap-1.5 py-1 pl-2 pr-2.5",
        )}
        // Bez podpisu nazwa modelu musi być choć w dymku — inaczej nie da się
        // sprawdzić, na czym bot pracuje, bez otwierania listy.
        title={activeLabel || selection.model}
        aria-label={activeLabel || selection.model}
      >
        {/* W wersji zwartej znak dostawcy jest jedyną treścią przycisku, więc
            rysujemy go ZAWSZE. Bez tego zostałby sam daszek. */}
        {(compact || active) && (
          <ProviderMark driverKind={active?.driverKind ?? "openaiCompatible"} size={14} />
        )}
        {!compact && <span className="max-w-[190px] truncate">{activeLabel}</span>}
        <ChevronDown size={14} className="text-ink-secondary" />
      </button>

      {open && (
        <div
          data-model-picker-content
          className="absolute right-0 top-full z-30 mt-2 flex w-[320px] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/50"
        >
          {/* instance rail */}
          <div className="flex flex-col gap-1 border-r border-hairline/40 bg-panel p-2">
            {visibleInstances.map((instance) => {
              const gate = instanceGate(instance.snapshot, instance.instanceId);
              const onRail = instance.instanceId === railInstance?.instanceId;
              return (
                <button
                  key={instance.instanceId}
                  onClick={() => setRailId(instance.instanceId)}
                  title={
                    gate === "missing"
                      ? `${instance.displayName} — ${instance.snapshot.reason ?? "unavailable"}`
                      : gate === "signin"
                        ? `${instance.displayName} — ${signInHint}`
                        : instance.displayName
                  }
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg",
                    onRail ? "bg-raised" : "hover:bg-raised/60",
                    gate === "missing" && "opacity-40",
                    gate === "signin" && "opacity-60",
                  )}
                >
                  <ProviderMark driverKind={instance.driverKind} size={18} />
                </button>
              );
            })}
          </div>

          {/* model list for the rail-selected instance */}
          <div className="min-w-0 flex-1 p-2">
            {railInstance ? (
              <>
                <div className="px-2 pb-1 pt-1">
                  <div className="text-[13px] font-semibold text-ink">{railInstance.displayName}</div>
                  <div className="truncate text-[11px] text-ink-secondary">
                    {railGate === "missing"
                      ? (railInstance.snapshot.reason ?? "unavailable")
                      : railGate === "signin"
                        ? (polish ? "niezalogowany" : "not signed in")
                        : railInstance.models.updatedAt
                          ? `${polish ? "modele zaktualizowane" : "models updated"} · ${new Date(railInstance.models.updatedAt).toLocaleString()}`
                          : (railInstance.snapshot.version ?? "ready")}
                  </div>
                  {/* Bez CLI cały wiersz jest martwy, a bez logowania tura pada
                      dopiero po wysłaniu — instalator i logowanie siedzą oba
                      w Ustawieniach aplikacji, więc daj skrót zamiast ślepej szarości. */}
                  {railGate !== "ok" && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        dispatch({ type: "toggleAppSettings", open: true });
                      }}
                      className="mt-1 text-[11px] text-accent hover:underline"
                    >
                      {railGate === "signin"
                        ? (polish ? "Zaloguj w Ustawieniach aplikacji" : "Sign in from App Settings")
                        : (polish ? "Zainstaluj w Ustawieniach aplikacji" : "Install in App Settings")}
                    </button>
                  )}
                </div>
                {railInstance.instanceId === "opencode" ? (
                  <>
                    {groupOpenCodeModels(railInstance.models.options).map((group) => (
                      <div key={group.id} className="mt-1">
                        <button
                          type="button"
                          aria-expanded={expandedOpenCodeGroups[group.id]}
                          onClick={() => setExpandedOpenCodeGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
                          className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium text-ink-secondary hover:bg-raised/60"
                        >
                          <ChevronRight size={13} className={cn("transition-transform", expandedOpenCodeGroups[group.id] && "rotate-90")} />
                          <span>{group.label}</span>
                          <span className="ml-auto text-[10px]">
                            {group.options.length} {polish ? "modeli" : "models"}
                          </span>
                        </button>
                        {expandedOpenCodeGroups[group.id] && group.options.map((option) =>
                          modelRow(railInstance, option, {
                            indent: true,
                            needsKey: group.id === "go" && opencodeKeyMissing,
                          }))}
                      </div>
                    ))}
                    {pendingGoModel && (
                      <div className="mx-2 mt-2 rounded-lg border border-hairline/40 bg-inset p-3">
                        <div className="mb-2 text-[12px] text-ink-secondary">
                          {polish ? "Ten model wymaga wspólnego klucza OpenCode Go." : "This model needs the shared OpenCode Go key."}
                        </div>
                        <ApiKeyRow
                          section="opencode"
                          label="OpenCode Go API key"
                          placeholder="Wklej klucz OpenCode Go"
                          onSaved={(configured) => {
                            if (!configured || !pendingGoModel) return;
                            dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: "opencode", model: pendingGoModel } });
                            setPendingGoModel(null);
                            setOpen(false);
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : railInstance.models.options.map((option) => modelRow(railInstance, option))}
              </>
            ) : (
              <div className="flex items-center gap-2 px-2 py-3 text-[13px] text-ink-secondary">
                <Loader2 size={14} className="animate-spin" /> {polish ? "Ładowanie modeli…" : "Loading models…"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
