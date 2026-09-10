// multibot: scout folderu → manifest zespołu (port z upstreamu #339)
// Modal wpisuje ścieżkę, pokazuje propozycję zespołu, import tworzy boty.
import { useState } from "react";
import { Check, Folder, Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { useStore } from "@/state/store";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/cn";

interface ScoutManifest {
  lead: { name: string; role: string; description: string };
  specialists: Array<{ name: string; role: string; description: string }>;
  evidence: string[];
  stack: string[];
}

export function ScoutTeamModal({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ScoutManifest | null>(null);

  const scout = async () => {
    if (!cwd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`/api/teams/scout?cwd=${encodeURIComponent(cwd.trim())}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { manifest: ScoutManifest };
      setManifest(body.manifest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importAll = async () => {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch("/api/teams/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { created: Array<{ id: string; name: string }> };
      // przeładuj listę botów, żeby UI zobaczył świeże rekordy
      try {
        const fresh = await authFetch("/api/bots");
        if (fresh.ok) {
          const data = (await fresh.json()) as { bots: typeof state.bots };
          dispatch({ type: "hydrate", bots: data.bots });
        }
      } catch {}
      onClose();
      void body;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-shell-overlay className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-[640px] max-w-full flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-panel shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-3">
          <div className="flex items-center gap-2">
            <Folder size={16} className="text-ink-secondary" />
            <span className="text-[15px] font-semibold text-ink">{polish ? "Zespół z folderu" : "Scout team from folder"}</span>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-ink-secondary hover:bg-raised hover:text-ink">
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <label className="text-[13px] text-ink-secondary">{polish ? "Ścieżka do folderu projektu" : "Project folder path"}</label>
          <div className="flex gap-2">
            <input
              autoFocus
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void scout();
                if (e.key === "Escape") onClose();
              }}
              placeholder="C:\Projects\myapp"
              className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none"
            />
            <button
              type="button"
              onClick={() => void scout()}
              disabled={busy || !cwd.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] text-white hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              {polish ? "Skanuj" : "Scan"}
            </button>
          </div>
          {error && (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>
          )}
          {manifest && (
            <div className="flex flex-col gap-3 overflow-y-auto">
              <div className="flex flex-wrap gap-1.5">
                {manifest.stack.map((s) => (
                  <span key={s} className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-secondary">{s}</span>
                ))}
              </div>
              <RoleRow tone="accent" label={polish ? "Lider" : "Lead"} role={manifest.lead} />
              {manifest.specialists.map((s, i) => <RoleRow key={`${s.role}-${i}`} tone="muted" label={s.role} role={s} />)}
              <button
                type="button"
                onClick={() => void importAll()}
                disabled={busy}
                className={cn(
                  "mt-2 flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] text-white hover:opacity-90 disabled:opacity-40",
                )}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {polish ? `Utwórz ${manifest.specialists.length + 1} botów` : `Create ${manifest.specialists.length + 1} bots`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RoleRow({ tone, label, role }: { tone: "accent" | "muted"; label: string; role: ScoutManifest["lead"] | ScoutManifest["specialists"][number] }) {
  return (
    <div className={cn("rounded-xl border px-3 py-2", tone === "accent" ? "border-accent/30 bg-accent/10" : "border-hairline/40 bg-card")}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{label}</div>
      <div className="text-[14px] font-semibold text-ink">{role.name} <span className="text-ink-secondary">· {role.role}</span></div>
      <div className="text-[12.5px] text-ink-secondary">{role.description}</div>
    </div>
  );
}