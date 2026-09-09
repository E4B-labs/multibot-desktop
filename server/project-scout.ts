// multibot: project scout (port z MultiBot #339, server/project-scout.ts).
// Deterministyczny skan pliku na podstawie package.json / pyproject / README i
// listy katalogów. Bez żadnych zgadywania — tylko zapisane dowody. Sugeruje
// manifest zespołu (lead + specjaliści), który import-side tworzy boty przez
// istniejący POST /api/teams/import (addytywnie, nigdy nie modyfikuje istniejących).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ScoutRole {
  name: string;
  role: string;
  description: string;
}

export interface ScoutManifest {
  lead: ScoutRole;
  specialists: ScoutRole[];
  evidence: string[];
  stack: string[];
}

export interface ScoutError {
  kind: "missing" | "not_directory" | "too_deep";
  message: string;
}

const FILE_LIMIT = 256 * 1024; // 256 KB
const ENTRY_LIMIT = 400;
const STACK_MARKERS: Array<{ key: string; marker: RegExp; chip: string }> = [
  { key: "react", marker: /from ["']react["']|\breact\b/i, chip: "react" },
  { key: "next", marker: /from ["']next\//i, chip: "next" },
  { key: "vue", marker: /from ["']vue["']/i, chip: "vue" },
  { key: "typescript", marker: /\.tsx?["']|\btsconfig\.json\b/i, chip: "typescript" },
  { key: "tailwind", marker: /tailwindcss|@tailwind/i, chip: "tailwind" },
  { key: "node", marker: /\bnode\b.*package\.json|engines.+node/i, chip: "node" },
  { key: "fastapi", marker: /from fastapi|import fastapi/i, chip: "fastapi" },
  { key: "pydantic", marker: /from pydantic|import pydantic/i, chip: "pydantic" },
  { key: "rust", marker: /Cargo\.toml|fn main\(/i, chip: "rust" },
  { key: "go", marker: /package main|go\.mod/i, chip: "go" },
];

const DETECTORS: Array<{ role: string; description: string; match: (cwd: string, files: string[], deps: string[]) => boolean }> = [
  {
    role: "Frontend",
    description: "Implementuje UI, styl, dostępność, komponenty interaktywne",
    match: (_cwd, files, deps) => files.some((f) => /^src\/(components|pages|app)\//.test(f)) || deps.includes("react") || deps.includes("vue"),
  },
  {
    role: "Backend",
    description: "API, warstwa biznesowa, modele, integracje serwerowe",
    match: (_cwd, files, deps) => files.some((f) => /^server\//.test(f) || /^src\/server\//.test(f)) || deps.includes("fastapi") || deps.includes("express") || deps.includes("hono"),
  },
  {
    role: "Testing",
    description: "Suita testów, regresja, jakość pokrycia, weryfikacja krytycznych ścieżek",
    match: (_cwd, files) => files.some((f) => /(?:^|\/)(__tests__|tests|spec)\//.test(f)) || files.includes("vitest.config.ts") || files.includes("pytest.ini") || files.includes("playwright.config.ts"),
  },
  {
    role: "Documentation",
    description: "Pisze i porządkuje dokumentację, README, komentarze, release notes",
    match: (_cwd, files) => files.includes("README.md") || files.includes("CONTRIBUTING.md"),
  },
  {
    role: "Infrastructure",
    description: "Build, CI, kontenery, deploy, środowiska runtime",
    match: (_cwd, files) => files.some((f) => /^(Dockerfile|\.github\/workflows\/|compose\.ya?ml|helm\/)/.test(f)),
  },
];

function readLimit(path: string): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > FILE_LIMIT) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function listFiles(cwd: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.slice(0, ENTRY_LIMIT)) {
    if (entry.startsWith(".") && entry !== ".github") continue;
    if (entry === "node_modules" || entry === "dist" || entry === "build" || entry === "release") continue;
    out.push(entry);
    const full = join(cwd, entry);
    try {
      if (statSync(full).isDirectory()) {
        for (const inner of readdirSync(full).slice(0, 50)) {
          if (inner.startsWith(".")) continue;
          out.push(`${entry}/${inner}`);
        }
      }
    } catch {}
  }
  return out;
}

function readDeps(files: string[], cwd: string): string[] {
  const pkg = files.includes("package.json") ? JSON.parse(readLimit(join(cwd, "package.json")) || "{}") : {};
  const allDeps: Record<string, unknown> = {
    ...(pkg.dependencies as Record<string, unknown> | undefined ?? {}),
    ...(pkg.devDependencies as Record<string, unknown> | undefined ?? {}),
  };
  return Object.keys(allDeps);
}

function detectStack(files: string[], deps: string[]): string[] {
  const blobs = files.map((f) => `${f} `).join("");
  const depBlob = deps.join(" ");
  const chips: string[] = [];
  for (const marker of STACK_MARKERS) {
    if (marker.marker.test(blobs) || marker.marker.test(depBlob)) chips.push(marker.chip);
  }
  return chips;
}

function pickLead(stack: string[]): ScoutRole {
  if (stack.some((s) => ["rust", "go", "node", "fastapi"].includes(s))) {
    return { name: "Compass", role: "Architect", description: "Rozumie całość repozytorium: strukturę, typy, granice modułów. Pomaga w nawigacji, planowaniu i decyzjach architektonicznych" };
  }
  return { name: "Compass", role: "Architect", description: "Koordynuje zespół, wybiera specjalistów do zadania, pilnuje spójności projektu" };
}

function buildSpecialists(files: string[], deps: string[], _evidence: string[]): ScoutRole[] {
  const found = DETECTORS.filter((d) => d.match("", files, deps)).slice(0, 5);
  if (found.length === 0) {
    return [{ name: "Wrench", role: "Generalist", description: "Pomaga we wszystkim, gdy nikt bardziej konkretny nie pasuje do zadania" }];
  }
  return found.map((d) => ({ name: d.role, role: d.role, description: d.description }));
}

export function scoutProject(cwd: string): ScoutManifest | ScoutError {
  if (!existsSync(cwd)) return { kind: "missing", message: "folder nie istnieje" };
  let stat;
  try {
    stat = statSync(cwd);
  } catch (error) {
    return { kind: "missing", message: error instanceof Error ? error.message : String(error) };
  }
  if (!stat.isDirectory()) return { kind: "not_directory", message: "ścieżka nie jest katalogiem" };

  const files = listFiles(cwd);
  const deps = readDeps(files, cwd);
  const readme = files.includes("README.md") ? readLimit(join(cwd, "README.md")) : "";
  const packageJson = files.includes("package.json") ? readLimit(join(cwd, "package.json")) : "";
  const evidence: string[] = [];
  if (readme) {
    const h1 = readme.split("\n").find((line) => line.trim().startsWith("# "));
    if (h1) evidence.push(h1.replace(/^#+\s*/, "").trim());
    const firstPara = readme.split(/\n\s*\n/).slice(1, 2).join("\n").trim();
    if (firstPara) evidence.push(firstPara.slice(0, 240));
  }
  if (packageJson && !readme) {
    const pkg = JSON.parse(packageJson) as { description?: string };
    if (pkg.description) evidence.push(pkg.description);
  }
  const stack = detectStack(files, deps);
  const specialists = buildSpecialists(files, deps, evidence);
  const lead = pickLead(stack);
  return { lead, specialists, evidence, stack };
}