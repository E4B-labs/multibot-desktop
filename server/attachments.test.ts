import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentStore, fileMime, MAX_IMAGE_BYTES, resolveBotFile } from "./attachments.ts";

const roots: string[] = [];
const make = () => {
  const root = mkdtempSync(join(tmpdir(), "multibot-attachments-"));
  roots.push(root);
  return { root, store: new AttachmentStore(root) };
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

// Regresja: bot zapisywal plik wlasna powloka, a potem probowal wepchnac go
// base64-em przez jej wyjscie. Przy trzydziestu kilobajtach wyjscie sie ucinalo
// i plik nigdy nie docieral. Teraz bot podaje sciezke ze swojego swiata, a
// harness ma ja umiec znalezc u siebie.
describe("resolveBotFile", () => {
  it("finds a file under a configured bot filesystem root", () => {
    const root = mkdtempSync(join(tmpdir(), "multibot-botfs-"));
    mkdirSync(join(root, "root"), { recursive: true });
    writeFileSync(join(root, "root", "report.html"), "<h1>hi</h1>");

    // Bot widzi `/root/report.html`; harness ma ten plik pod korzeniem kontenera.
    expect(resolveBotFile("/root/report.html", root)).toBe(resolve(root, "root", "report.html"));
    rmSync(root, { recursive: true, force: true });
  });

  it("says where it looked when the file is nowhere", () => {
    expect(() => resolveBotFile("/root/nie-ma.html", "/tmp/pusty-korzen")).toThrow(/no such file/);
  });

  it("rejects an empty path instead of resolving to the working directory", () => {
    expect(() => resolveBotFile("   ")).toThrow(/path required/);
  });
});

// Regresja (K6, zmierzone 11.09.2026 na zywym haiku): `send_file` bierze MIME
// od modelu, model go pomijal, plik `red_square.png` ladowal w czacie jako
// `application/octet-stream` i transkrypt pokazywal szary kafelek zamiast
// obrazka. Bot mowil "wyslalem obrazek", a obrazka nie bylo widac.
describe("fileMime", () => {
  it("czyta MIME z rozszerzenia, gdy model go nie podal albo wrzucil worek", () => {
    expect(fileMime("red_square.png", "application/octet-stream")).toBe("image/png");
    expect(fileMime("red_square.PNG")).toBe("image/png");
    expect(fileMime("notes.txt", "")).toBe("text/plain");
    expect(fileMime("data.csv", "nonsense")).toBe("text/csv");
  });

  it("sensowna deklaracja modelu wygrywa nad rozszerzeniem", () => {
    expect(fileMime("notes.txt", "text/markdown")).toBe("text/markdown");
    expect(fileMime("chart.png", "image/jpeg")).toBe("image/jpeg");
  });

  // Model wpisuje w to pole byle co, a od tego zalezy `<img>` kontra kafelek.
  it("rozszerzenie obrazka bije deklaracje, ktora obrazkiem nie jest", () => {
    expect(fileMime("chart.png", "text/plain")).toBe("image/png");
    expect(fileMime("chart.png", "binary/octet-stream")).toBe("image/png");
  });

  // Tresc AKTYWNA nie powstaje ze zgadywania po nazwie: nazwa przychodzi od
  // modelu, a `text/html` z trasy pobrania biegl na originie aplikacji.
  it("nie zgaduje typow wykonywalnych z nazwy pliku", () => {
    for (const name of ["report.html", "page.htm", "logo.svg", "feed.xml"]) {
      expect(fileMime(name)).toBe("application/octet-stream");
    }
    // Zadeklarowany jawnie przechodzi jak dotad — bramka jest wtedy
    // `content-disposition` na trasie pobrania, nie to MIME.
    expect(fileMime("report.html", "text/html")).toBe("text/html");
  });

  it("nieznane rozszerzenie zostaje workiem, jak dotad", () => {
    expect(fileMime("dump.qqq")).toBe("application/octet-stream");
    expect(fileMime("bez-rozszerzenia")).toBe("application/octet-stream");
  });
});

describe("attachment store", () => {
  it("persists metadata, enforces ownership and deletes files with bot", () => {
    const { root, store } = make();
    const file = store.add("bot-a", "photo.png", "image/png", Buffer.from("png"));
    expect(store.resolve("bot-a", file.id)).toMatchObject(file);
    expect(() => store.resolve("bot-b", file.id)).toThrow(/no such attachment/);
    expect(new AttachmentStore(root).resolve("bot-a", file.id)).toMatchObject(file);
    store.deleteBot("bot-a");
    expect(existsSync(join(root, "bot-a"))).toBe(false);
  });

  it("zapisuje obrazek jako obrazek i mierzy go limitem obrazka, mimo worka od modelu", () => {
    const { store } = make();
    expect(store.add("bot", "chart.png", "application/octet-stream", Buffer.from("png")).mime).toBe("image/png");
    // Limit idzie za wywnioskowanym MIME, nie za deklaracją: wcześniej obrazek
    // podany jako octet-stream przechodził przez limit dokumentu (25 MB).
    expect(() => store.add("bot", "huge.png", "application/octet-stream", Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow(/8 MB/);
  });

  it("rejects traversal, duplicate ids, count and image size limits", () => {
    const { store } = make();
    expect(() => store.add("bot", "../secret", "text/plain", Buffer.from("x"))).toThrow(/invalid file name/);
    expect(() => store.add("bot", "large.png", "image/png", Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow(/8 MB/);
    const file = store.add("bot", "one.txt", "text/plain", Buffer.from("x"));
    expect(() => store.resolveMany("bot", [file.id, file.id])).toThrow(/invalid attachment ids/);
    expect(() => store.resolveMany("bot", Array.from({ length: 11 }, () => crypto.randomUUID()))).toThrow(/maximum 10/);
  });
});
