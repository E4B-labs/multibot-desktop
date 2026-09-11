import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId, type AttachmentMeta } from "./contracts.ts";

export const MAX_ATTACHMENTS = 10;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface StoredAttachment extends AttachmentMeta {
  botId: string;
  storedName: string;
}

/**
 * Korzenie systemów plików, w których bot może trzymać swoje pliki, wykryte
 * z dysku zamiast wpisane w konfigurację.
 *
 * Na telefonie CLI dostawców chodzą w prooct, gdzie bot ma `HOME=/root`.
 * Harness siedzi w Termuksie i ten sam plik widzi dopiero pod korzeniem
 * kontenera. Ścieżka do tego korzenia zmienia się między wersjami
 * `proot-distro` (widziane: `containers/<distro>/rootfs` oraz
 * `installed-rootfs/<distro>`), więc wpisanie jej na sztywno psuje się po
 * pierwszej aktualizacji — i psuje się cicho, bo objawem jest tylko brak
 * załącznika.
 *
 * Poza Termuksem katalog nie istnieje, lista wychodzi pusta i nic się nie
 * zmienia.
 */
export function prootRoots(prefixOverride?: string): string[] {
  const prefix = prefixOverride ?? process.env.PREFIX ?? "/data/data/com.termux/files/usr";
  const base = join(prefix, "var", "lib", "proot-distro");
  const roots: string[] = [];
  for (const layout of ["containers", "installed-rootfs"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(base, layout));
    } catch {
      continue;
    }
    for (const distro of entries) {
      // Nowszy układ trzyma system plików o poziom głębiej; starszy nie.
      for (const candidate of [join(base, layout, distro, "rootfs"), join(base, layout, distro)]) {
        if (existsSync(join(candidate, "root")) || existsSync(join(candidate, "etc"))) roots.push(candidate);
      }
    }
  }
  return roots;
}

/**
 * Ścieżka podana przez bota, przetłumaczona na ścieżkę widzianą przez harness.
 *
 * Bot podaje ścieżkę ze SWOJEGO świata. Próbujemy jej najpierw wprost (docker,
 * maszyna deweloperska, ten sam system plików), potem doklejonej do każdego
 * wykrytego korzenia.
 *
 * Bez tego bot musiał wpychać zawartość pliku base64-em przez wyjście własnej
 * powłoki — a to ucina się przy pierwszym pliku większym niż kilkanaście
 * kilobajtów i plik nigdy nie dociera do użytkownika.
 *
 * `MULTIBOT_BOT_FS_ROOT` zostaje jako ręczne nadpisanie dla układów, których
 * wykrywanie nie zna; pusta zmienna nic nie zmienia.
 */
export function resolveBotFile(path: string, roots?: string): string {
  const raw = String(path ?? "").trim();
  if (!raw) throw Object.assign(new Error("path required"), { status: 422 });
  const configured = (roots ?? process.env.MULTIBOT_BOT_FS_ROOT ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const relative = raw.replace(/^[/\\]+/, "");
  const candidates = [
    resolve(raw),
    ...[...configured, ...prootRoots()].map((root) => resolve(root, relative)),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw Object.assign(
      new Error(`no such file: ${raw} (looked in ${candidates.join(", ")})`),
      { status: 404 },
    );
  }
  return found;
}

/**
 * Rozszerzenie → MIME, dla rodzin, które transkrypt umie pokazać inaczej niż
 * kafelkiem do pobrania. Tylko to, co naprawdę przychodzi od botów.
 */
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon",
  pdf: "application/pdf", html: "text/html", htm: "text/html",
  csv: "text/csv", json: "application/json", md: "text/markdown", txt: "text/plain",
  xml: "application/xml", yaml: "text/yaml", yml: "text/yaml", zip: "application/zip",
};

/**
 * MIME załącznika: deklaracja, a gdy jej nie ma — rozszerzenie nazwy pliku.
 *
 * `send_file` bierze MIME OD MODELU, a model go nagminnie pomija albo wpisuje
 * `application/octet-stream` (zmierzone 11.09.2026 na żywym haiku: plik
 * `red_square.png` dotarł jako octet-stream). Transkrypt renderuje obrazek po
 * `image/*` (`MessageAttachment` w `src/components/ChatView.tsx`), więc wysłana
 * grafika pokazywała się użytkownikowi jako szary kafelek z „Pobierz" — bot
 * mówił „wysłałem obrazek", a obrazka nie było widać. Nazwa pliku jest tu
 * wiarygodniejsza od deklaracji modelu.
 *
 * Sensowna deklaracja wygrywa; `application/octet-stream` i śmieci ustępują
 * rozszerzeniu, a rozszerzenie spoza mapy zostawia `application/octet-stream`
 * dokładnie jak dotąd.
 */
export function fileMime(name: string, declared?: string): string {
  const value = String(declared ?? "").trim().toLowerCase();
  const valid = /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : "";
  if (valid && valid !== "application/octet-stream") return valid;
  const ext = String(name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

const cleanName = (value: string) => {
  const name = value.trim();
  if (!name || name.length > 180 || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw Object.assign(new Error("invalid file name"), { status: 422 });
  }
  return name;
};

export class AttachmentStore {
  private readonly root: string;
  private readonly manifest: string;
  private data: StoredAttachment[];

  constructor(root = join(DATA_DIR, "attachments")) {
    this.root = resolve(root);
    this.manifest = join(this.root, "attachments.json");
    try {
      this.data = JSON.parse(readFileSync(this.manifest, "utf8"));
    } catch {
      this.data = [];
    }
  }

  add(botId: string, name: string, mime: string, bytes: Buffer): AttachmentMeta {
    const safeName = cleanName(name);
    const safeMime = fileMime(safeName, mime);
    const limit = safeMime.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!bytes.length) throw Object.assign(new Error("empty file"), { status: 422 });
    if (bytes.length > limit) throw Object.assign(new Error(`file exceeds ${limit / 1024 / 1024} MB limit`), { status: 413 });
    const id = newId();
    const dir = this.botDir(botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const storedName = id;
    writeFileSync(join(dir, storedName), bytes, { mode: 0o600 });
    const record: StoredAttachment = { id, botId, name: safeName, mime: safeMime, size: bytes.length, storedName };
    this.data.push(record);
    this.save();
    return this.public(record);
  }

  resolve(botId: string, id: string): StoredAttachment & { path: string } {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error("invalid attachment id"), { status: 422 });
    const record = this.data.find((item) => item.id === id && item.botId === botId);
    if (!record) throw Object.assign(new Error("no such attachment"), { status: 404 });
    const path = resolve(this.botDir(botId), record.storedName);
    if (!path.startsWith(`${this.botDir(botId)}${sep}`) || !existsSync(path)) {
      throw Object.assign(new Error("attachment file missing"), { status: 404 });
    }
    return { ...record, path };
  }

  resolveMany(botId: string, ids: unknown): Array<StoredAttachment & { path: string }> {
    if (!Array.isArray(ids)) return [];
    if (ids.length > MAX_ATTACHMENTS) throw Object.assign(new Error(`maximum ${MAX_ATTACHMENTS} attachments`), { status: 422 });
    if (new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string")) {
      throw Object.assign(new Error("invalid attachment ids"), { status: 422 });
    }
    return ids.map((id) => this.resolve(botId, id));
  }

  deleteBot(botId: string): void {
    const dir = this.botDir(botId);
    if (dir.startsWith(`${this.root}${sep}`)) rmSync(dir, { recursive: true, force: true });
    const before = this.data.length;
    this.data = this.data.filter((item) => item.botId !== botId);
    if (this.data.length !== before) this.save();
  }

  private botDir(botId: string): string {
    if (!/^[\w-]+$/.test(botId)) throw Object.assign(new Error("invalid bot id"), { status: 422 });
    return resolve(this.root, botId);
  }

  private public(record: StoredAttachment): AttachmentMeta {
    return { id: record.id, name: record.name, mime: record.mime, size: record.size };
  }

  private save(): void {
    mkdirSync(dirname(this.manifest), { recursive: true, mode: 0o700 });
    writeFileSync(this.manifest, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
