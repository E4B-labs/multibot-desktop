import { ChevronLeft, ImagePlus, Pencil, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { BOT_COLORS, BOT_COLOR_NAMES, pickerAvatarState } from "@/lib/mascot";
import { MASCOT_SHAPES } from "@/lib/mascotShapes";
import { ModelPicker } from "./ModelPicker";
import { EngineAutonomy } from "./EngineAutonomy";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { requestBrowserNotifications } from "@/lib/notifications";
import { useLanguage } from "@/lib/language";
import { botDisplayName, botDisplayTitle } from "@/lib/botNames";
import { AvatarCropper } from "./AvatarCropper";
import { Spinner } from "./Loading";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[12px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

function BotSharing({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [visibility, setVisibility] = useState<"team" | "private">(bot.visibility === "private" ? "private" : "team");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      authFetch("/api/bots/" + bot.id + "/sharing").then((response) => response.ok ? response.json() : Promise.reject(new Error("sharing unavailable"))),
    ]).then(([sharing]) => {
      if (!alive) return;
      setVisibility(sharing.visibility === "private" ? "private" : "team");
    }).catch((reason) => alive && setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [bot.id]);

  const save = async (nextVisibility: typeof visibility) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch("/api/bots/" + bot.id + "/sharing", {
        method: "PATCH",
        body: JSON.stringify({ visibility: nextVisibility }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? String(response.status) + " " + response.statusText);
      setVisibility(body.visibility);
      dispatch({ type: "botPatched", bot: { id: bot.id, visibility: body.visibility, ownerId: body.ownerId ?? undefined } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl bg-card p-3">
      <div className="text-[14px] font-medium text-ink">{polish ? "Widoczność bota" : "Bot visibility"}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {polish ? "Zespołowy dla wszystkich albo prywatny tylko dla właściciela." : "Team-visible for everyone or private to its owner."}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <select
          value={visibility}
          disabled={busy || loading}
          onChange={(event) => {
            const value = event.target.value as typeof visibility;
            setVisibility(value);
            void save(value);
          }}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50"
        >
          <option value="team">{polish ? "Zespół" : "Team"}</option>
          <option value="private">{polish ? "Prywatny" : "Private"}</option>
        </select>
        {(loading || busy) && <Spinner className="shrink-0 text-ink-secondary" />}
      </div>
      {!loading && visibility === "private" &&<div className="mt-2 text-[12px] text-ink-secondary">{polish ? "Inni członkowie nie zobaczą bota, pamięci ani rozmów." : "Other members cannot see this bot, its memory, or its conversations."}</div>}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

type AppearanceMode = "closed" | "bot" | "photo";

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [query, setQuery] = useState("");
  // Kliknięcie awatara otwiera panel wyglądu; wybór konkretnego trybu odbywa
  // się w zakładkach Bot / Prześlij.
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>("closed");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = cardsRef.current;
    if (!container) return;
    const needle = query.trim().toLocaleLowerCase();
    for (const card of Array.from(container.children)) {
      const match = !needle || (card.textContent ?? "").toLocaleLowerCase().includes(needle);
      (card as HTMLElement).style.display = match ? "" : "none";
    }
  }, [query, appearanceMode]);
  const patch = (
    p: Partial<
      Pick<Bot, "name" | "title" | "description" | "notifications" | "color" | "mascotExpression" | "mascotShape" | "avatarUrl">
    >,
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = pickerAvatarState(bot);

  const handleAvatarClick = () => setAppearanceMode((m) => (m === "closed" ? "bot" : "closed"));

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setPendingFile(f);
    e.target.value = "";
  };

  const saveAvatar = async (dataUrl: string) => {
    setAvatarBusy(true);
    try {
      const res = await authFetch(`/api/bots/${bot.id}/avatar`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: dataUrl }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "upload failed");
      const updated = body.bot as Bot;
      dispatch({ type: "botPatched", bot: updated });
      setPendingFile(null);
      setAppearanceMode("closed");
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    try {
      const res = await authFetch(`/api/bots/${bot.id}/avatar`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "delete failed");
      dispatch({ type: "botPatched", bot: { id: bot.id, avatarUrl: null } });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <aside className="animate-panel-in flex h-full w-[320px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div data-shell-header className="flex items-center justify-between px-3 py-2.5">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[14px] font-semibold text-ink">{polish ? "Ustawienia" : "Settings"}</span>
      </div>

      <div className="px-5 pb-1">
        <div className="flex items-center gap-2 rounded-xl border border-hairline/40 bg-card px-3 py-2">
          <Search size={14} className="shrink-0 text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (query) setQuery("");
              }
            }}
            placeholder={polish ? "Szukaj w ustawieniach…" : "Search settings…"}
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={polish ? "Wyczyść" : "Clear"}
              className="shrink-0 rounded-md p-0.5 text-ink-secondary hover:text-ink"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="flex flex-col items-center py-4 gap-2">
          <button
            type="button"
            onClick={handleAvatarClick}
            aria-expanded={appearanceMode !== "closed"}
            title={polish ? "Zmień wygląd bota" : "Change bot appearance"}
            aria-label={polish ? "Zmień wygląd bota" : "Change bot appearance"}
            className="group relative rounded-full ring-offset-4 ring-offset-panel transition hover:opacity-90 focus:outline-none"
          >
            <BotAvatar
              color={bot.color}
              shape={bot.mascotShape}
              avatarUrl={bot.avatarUrl}
              state={activeState}
              size={72}
              animated={false}
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
              <Pencil size={24} strokeWidth={2.2} />
            </span>
          </button>
          {appearanceMode === "bot" && (
            <div className="text-[11px] text-ink-secondary/70">
              {polish ? "Wybierz kształt i kolor awatara" : "Choose the avatar shape and color"}
            </div>
          )}
        </div>

        <div ref={cardsRef} className="flex flex-col gap-3">

          {appearanceMode !== "closed" && (
            <div key={appearanceMode} className="animate-panel-in overflow-hidden rounded-xl border border-hairline/40 bg-card">
              <div className="flex items-center justify-between border-b border-hairline/40 px-2.5 py-2">
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setAppearanceMode("bot")}
                    className={cn("rounded-lg px-2.5 py-1 text-[13px] font-medium", appearanceMode === "bot" ? "bg-accent text-white" : "bg-raised text-ink-secondary hover:text-ink")}
                  >
                    {polish ? "Bot" : "Bot"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAppearanceMode("photo")}
                    className={cn("flex items-center gap-1 rounded-lg px-2.5 py-1 text-[13px] font-medium", appearanceMode === "photo" ? "bg-accent text-white" : "bg-raised text-ink-secondary hover:text-ink")}
                  >
                    <ImagePlus size={14} /> {polish ? "Prześlij" : "Upload"}
                  </button>
                </div>
                {appearanceMode === "bot" && (
                  <button
                    type="button"
                    onClick={() => patch({ color: "green", mascotExpression: null, mascotShape: "blob" })}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
                  >
                    {polish ? "Resetuj" : "Reset"}
                  </button>
                )}
                {appearanceMode === "photo" && bot.avatarUrl && (
                  <button type="button" onClick={removeAvatar} disabled={avatarBusy} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-danger hover:bg-raised disabled:opacity-50">
                    {avatarBusy && <Spinner size={12} />}
                    {polish ? "Usuń" : "Remove"}
                  </button>
                )}
              </div>

              {appearanceMode === "bot" ? (
                <div className="p-2.5">
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                    {polish ? "Kształt ikony" : "Icon shape"}
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {MASCOT_SHAPES.map((shape) => (
                      <button
                        type="button"
                        key={shape}
                        onClick={() => patch({ mascotShape: shape })}
                        className={cn(
                          "flex h-[46px] items-center justify-center rounded-lg bg-inset transition-colors hover:bg-raised",
                          (bot.mascotShape ?? "blob") === shape && "ring-2 ring-accent-border",
                        )}
                        title={shape}
                        aria-label={`${polish ? "Użyj kształtu ikony" : "Use"} ${shape}`}
                      >
                        <BotAvatar color={bot.color} shape={shape} avatarUrl={null} state={activeState} size={32} animated={false} trackPointer={false} showFace={false} />
                      </button>
                    ))}
                  </div>

                  <div className="mb-1.5 mt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                    {polish ? "Kolor" : "Color"}
                  </div>
                  {/* Siedem kolumn pod 14 barw z BOT_COLOR_NAMES — dwa pelne
                      rzedy. Zawijany flex zostawial w drugim rzedzie dziury po
                      brakujacych pozycjach. */}
                  <div className="grid grid-cols-7 justify-items-center gap-2">
                    {BOT_COLOR_NAMES.map((color) => (
                      <button
                        type="button"
                        key={color}
                        onClick={() => patch({ color })}
                        className={cn(
                          // Obwódka, nie przezroczysta: `bg-card` na jasnych
                          // motywach to biel, więc biała próbka bez niej znika.
                          "size-7 rounded-full border-2 border-hairline/70 transition-transform hover:scale-110",
                          bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                        )}
                        style={{ backgroundColor: BOT_COLORS[color] }}
                        title={color}
                        aria-label={`${polish ? "Użyj koloru awatara" : "Use mascot color"}: ${color}`}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-3">
                  {!pendingFile ? (
                    <div className="flex flex-col items-center gap-3">
                      {bot.avatarUrl ? (
                        <img src={bot.avatarUrl} alt="avatar" className="size-[120px] rounded-full border border-hairline/30 object-cover" />
                      ) : (
                        <div className="flex size-[120px] items-center justify-center rounded-full border border-dashed border-hairline bg-inset">
                          <ImagePlus size={28} className="text-ink-secondary" />
                        </div>
                      )}
                      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFilePick} />
                      <button type="button" onClick={() => fileInputRef.current?.click()} disabled={avatarBusy} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
                        {bot.avatarUrl ? (polish ? "Zmień zdjęcie" : "Change photo") : (polish ? "Wybierz zdjęcie" : "Choose photo")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <AvatarCropper file={pendingFile} onSave={saveAvatar} onCancel={() => setPendingFile(null)} />
                      {avatarBusy && (
                        <div className="mt-2 flex items-center justify-center gap-2 text-[12px] text-ink-secondary">
                          <Spinner size={12} /> {polish ? "Zapisywanie…" : "Saving…"}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <Field label={polish ? "Nazwa" : "Name"}>
            <input
              className={inputCls}
              value={botDisplayName(bot, polish ? "pl" : "en")}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label={polish ? "Rola" : "Title"}>
            <input
              className={inputCls}
              placeholder={polish ? "Opisz, czym zajmuje się bot" : "Describe what your agent does"}
              value={botDisplayTitle(bot, polish ? "pl" : "en")}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label={polish ? "Opis" : "Description"}>
            <textarea
              className={cn(inputCls, "min-h-[72px] resize-none")}
              placeholder={polish ? "Do czego służy ten bot" : "What this agent is for"}
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <BotSharing bot={bot} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-3">
            <div>
              <div className="text-[14px] font-medium text-ink">{polish ? "Model" : "Model"}</div>
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                {polish ? "Provider i model używany przez tego bota" : "Which provider and model this bot runs on"}
              </div>
            </div>
            <ModelPicker bot={bot} />
          </div>

          <EngineAutonomy key={`autonomy-${bot.id}`} bot={bot} />
          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-3">
            <div>
              <div className="text-[14px] font-medium text-ink">
                {polish ? "Powiadomienia" : "Notifications"}
              </div>
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                {polish ? "Powiadom, gdy bot skończy albo potrzebuje odpowiedzi" : "Get notified when this agent finishes or needs input"}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={bot.notifications}
              onClick={() => {
                if (!bot.notifications) void requestBrowserNotifications();
                patch({ notifications: !bot.notifications });
              }}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.notifications ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.notifications ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
