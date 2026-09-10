// multibot: plik .md upuszczony na panel Umiejętności → wiersz skilla.
// Serwer (`workspace.addSkill`) nie zna front-matteru, bierze gotowe
// {name, description, instructions} — więc rozbiera się to tutaj.
//
// ponytail: własne trzy linijki zamiast `gray-matter`/`js-yaml`. Front-matter
// skilla to płaskie `klucz: wartość`, a paczka webui jedzie na telefon jako
// jeden string HTML z twardym limitem 6 MB (patrz scripts/bundle-webui.mjs) —
// parser YAML-a jest tu czystym balastem.

export interface ParsedSkillFile {
  name: string;
  description: string;
  instructions: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const unquote = (value: string) => value.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();

function frontMatterValue(block: string, key: string): string {
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match && match[1].toLowerCase() === key) return unquote(match[2]);
  }
  return "";
}

/** Nazwa z pliku: `skill.md` w katalogu nic nie mówi, więc dla takiej nazwy
 *  (i dla pustej) zostaje pusty napis i decyduje nagłówek. */
function nameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.(md|markdown)$/i, "").split(/[\\/]/).pop() ?? "";
  return /^skill$/i.test(base) ? "" : base.trim();
}

export function parseSkillFile(fileName: string, content: string): ParsedSkillFile {
  const text = content.replace(/^﻿/, "");
  if (!text.trim()) throw new Error(`${fileName || "file"} is empty`);

  const matter = FRONT_MATTER.exec(text);
  const block = matter ? matter[1] : "";
  const body = (matter ? text.slice(matter[0].length) : text).trim();

  const heading = /^#{1,6}[ \t]+(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  const name = (frontMatterValue(block, "name") || heading || nameFromFileName(fileName)).slice(0, 80);
  if (!name) throw new Error(`${fileName || "file"}: no skill name (add front-matter \`name:\` or a \`#\` heading)`);

  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("---")) ?? "";
  const description = (frontMatterValue(block, "description") || firstLine).slice(0, 2_000);

  const instructions = body || block.trim();
  if (!instructions) throw new Error(`${fileName || "file"} has no instructions`);

  return { name, description, instructions };
}
