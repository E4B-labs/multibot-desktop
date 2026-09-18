// multibot: plik .md upuszczony na panel Umiejętności → wiersz skilla.
// Serwer (`workspace.addSkill`) nie zna front-matteru, bierze gotowe
// {name, description, instructions} — więc rozbiera się to tutaj.
//
// ponytail: własne kilkanaście linijek zamiast `gray-matter`/`js-yaml`.
// Front-matter skilla to płaskie `klucz: wartość`, a paczka webui jedzie na
// telefon jako jeden string HTML z twardym limitem 6 MB (patrz
// scripts/bundle-webui.mjs) — parser YAML-a jest tu czystym balastem.
// Świadomie NIE obsługiwane: kotwice, listy, zagnieżdżone mapy i bloki `|`/`>`
// (te ostatnie dają pusty opis zamiast literalnego „|”, patrz `scalarValue`).

export interface ParsedSkillFile {
  name: string;
  description: string;
  instructions: string;
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  if (quoted) return quoted[2].trim();
  // komentarz na końcu niecytowanej wartości: `name: deploy # tylko prod`
  return trimmed.replace(/\s+#.*$/, "").trim();
}

/** Blok `|`/`>` (i ich warianty) zwraca pusto zamiast literalnego znaku —
 *  lepszy brak opisu niż opis o treści „|". */
const scalarValue = (value: string) => (/^[|>][+-]?$/.test(value.trim()) ? "" : unquote(value));

/** Czy ten blok to naprawdę front-matter, czy zwykła kreska pozioma na górze
 *  pliku? Bez tego sprawdzenia `---\n\n# Tytuł\n\ntreść\n\n---\n dalszy ciąg`
 *  gubił wszystko do drugiej kreski, bez słowa ostrzeżenia. */
function isFrontMatter(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => /^\s/.test(line) || KEY_LINE.test(line));
}

function frontMatterValue(block: string, key: string): string {
  for (const line of block.split("\n")) {
    const match = KEY_LINE.exec(line);
    if (match && match[1].toLowerCase() === key) return scalarValue(match[2]);
  }
  return "";
}

/** Przycięcie do limitu serwera bez rozcinania pary surogatów w pół. */
const cut = (value: string, max: number) => value.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");

/** Nazwa z pliku: `skill.md` w katalogu nic nie mówi, więc dla takiej nazwy
 *  (i dla pustej) zostaje pusty napis i decyduje nagłówek. */
function nameFromFileName(fileName: string): string {
  // File.name z drag&dropa to sama nazwa, bez ścieżki
  const base = fileName.replace(/\.(md|markdown)$/i, "").trim();
  return /^skill$/i.test(base) ? "" : base;
}

export function parseSkillFile(fileName: string, content: string): ParsedSkillFile {
  const label = fileName || "file";
  // BOM i CRLF na wejściu; inaczej instrukcje wieloliniowe niosły \r do serwera
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new Error(`${label} is empty`);

  const matter = FRONT_MATTER.exec(text);
  const block = matter && isFrontMatter(matter[1]) ? matter[1] : "";
  const body = (block ? text.slice(matter![0].length) : text).trim();

  const heading = /^#{1,6}[ \t]+(.+?)[ \t]*#*$/m.exec(body)?.[1]?.trim() ?? "";
  const name = cut(frontMatterValue(block, "name") || heading || nameFromFileName(fileName), 80);
  if (!name) throw new Error(`${label}: no skill name (add front-matter \`name:\` or a \`#\` heading)`);

  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("---")) ?? "";
  const description = cut(frontMatterValue(block, "description") || firstLine, 2_000);

  if (!body) throw new Error(`${label} has front-matter but no instructions`);

  return { name, description, instructions: body };
}
