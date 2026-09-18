// multibot: awaryjne wyłapywanie matematyki pisanej ASCII-em.
//
// Bot POWINIEN pisać LaTeX (`$…$` / `$$…$$`) — mówi mu to prompt systemowy
// w `server/bot-prompt.ts`. Ale stare wiadomości i słabsze modele nadal
// wypluwają `a^(-n) = 1/a^n` albo `5^(2x-1) = 1/125` gołym tekstem, więc
// zanim markdown ruszy, opakowujemy TAKIE fragmenty w `$…$`.
//
// Zasada nadrzędna: fałszywy pozytyw jest gorszy niż przegapiona formuła.
// Dlatego ruszamy tylko fragment, który W CAŁOŚCI wygląda na wzór — cyfry,
// pojedyncze litery, operatory, nawiasy, `^`, `√`, `=` — i który zawiera
// choć jeden „matematyczny" znak (`^`, `√`, `sqrt`, albo ułamek `a/b`).
// Proza, URL-e, ścieżki plików i kod nigdy się w to nie łapią.

/** Znaki, z których wolno się składać kandydatowi na wzór. */
const FORMULA_CHARS = /^[0-9a-zA-Z\s^√()[\]{}+\-*/=<>.,!|_]+$/;

/** Musi być w kandydacie, inaczej to zwykły tekst („2 + 2", „a, b, c"). */
const HAS_MATH = /\^|√|\bsqrt\s*\(|[0-9a-zA-Z)\]]\s*\/\s*[0-9a-zA-Z(]/;

/** Dyskwalifikuje: ścieżki, URL-e, wersje, sufiksy typu `2^32-bit`. */
const LOOKS_LIKE_PATH = /[a-zA-Z]:[\\/]|:\/\/|\\|\.[a-zA-Z]{2,4}\b|-(?:bit|byte|based|old|way)\b/;

/** Słowa naturalnego języka — jedno wystarczy, by uznać fragment za prozę.
 *  Zmienne w matematyce to pojedyncze litery, ewentualnie `sin`/`cos`/`log`
 *  i `sqrt`; każde inne słowo 2+ liter znaczy, że to zdanie. */
const MATH_WORDS = new Set(["sqrt", "sin", "cos", "tan", "log", "ln", "exp", "lim", "max", "min", "mod", "pi"]);

function isProse(s: string): boolean {
  for (const word of s.match(/[a-zA-Z]{2,}/g) ?? []) {
    if (!MATH_WORDS.has(word.toLowerCase())) return true;
  }
  return false;
}

function looksLikeFormula(s: string): boolean {
  const t = s.trim();
  // ponytail: 2 znaki to za mało na wzór, 120 to już akapit — sufit celowy.
  if (t.length < 3 || t.length > 120) return false;
  if (!FORMULA_CHARS.test(t)) return false;
  if (LOOKS_LIKE_PATH.test(t)) return false;
  if (!HAS_MATH.test(t)) return false;
  if (isProse(t)) return false;
  // sam nawias/operator na końcu bez treści to nie wzór
  return /[0-9a-zA-Z]/.test(t);
}

/** ASCII → LaTeX wewnątrz JUŻ rozpoznanego wzoru. */
function toLatex(s: string): string {
  let out = s.trim();
  out = out.replace(/\bsqrt\s*\(([^()]*)\)/g, "\\sqrt{$1}");
  out = out.replace(/√\s*\(([^()]*)\)/g, "\\sqrt{$1}");
  out = out.replace(/√\s*([0-9]+|[a-zA-Z])/g, "\\sqrt{$1}");
  // wykładnik w nawiasie: a^(-n) → a^{-n}
  out = out.replace(/\^\s*\(([^()]*)\)/g, "^{$1}");
  // wykładnik goły wielo-znakowy: a^12 → a^{12}; jednoznakowy zostaje
  out = out.replace(/\^\s*([0-9a-zA-Z]{2,})/g, "^{$1}");
  out = out.replace(/\*/g, " \\cdot ");
  return out.replace(/\s+/g, " ").trim();
}

/** Fragmenty tekstu poza blokami kodu (``` … ``` oraz `…`). */
function outsideCode(text: string): Array<{ text: string; code: boolean }> {
  const parts: Array<{ text: string; code: boolean }> = [];
  const re = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index), code: false });
    parts.push({ text: m[0], code: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), code: false });
  return parts;
}

/** `$$…$$` w jednej linii to dla remark-math wzór INLINE — wyśrodkowany blok
 *  dostajemy dopiero, gdy `$$` stoją w osobnych wierszach. Bot pisze zwykle
 *  jednolinijkowo, więc rozbijamy to za niego. Linie z tekstem obok wzoru
 *  zostają nietknięte: tam inline jest poprawny. */
function normalizeDisplayMath(text: string): string {
  if (!text.includes("$$")) return text;
  return outsideCode(text)
    .map(({ text: chunk, code }) =>
      code
        ? chunk
        : chunk.replace(/^([ \t]*)\$\$[ \t]*(\S[\s\S]*?)[ \t]*\$\$[ \t]*$/gm, "$1$$$$\n$1$2\n$1$$$$"),
    )
    .join("");
}

/**
 * Owija wykryte wzory ASCII w `$…$`. Tekst już zawierający `$…$` lub `\(`
 * zostaje nietknięty — bot umiał LaTeX, nie ma czego ratować.
 */
export function asciiMathToLatex(text: string): string {
  const normalized = normalizeDisplayMath(text);
  // jakikolwiek LaTeX w tekście (inline, blok, `\(`, `\[`) = bot umiał sam,
  // nie ma czego ratować i nie wolno mu niczego dopisywać
  if (/\$[^$\n]+\$|\$\$|\\\(|\\\[/.test(normalized)) return normalized;
  if (!HAS_MATH.test(normalized)) return normalized;

  return outsideCode(normalized)
    .map(({ text: chunk, code }) => {
      if (code) return chunk;
      return chunk
        .split("\n")
        .map((line) => {
          // wiersz w całości będący wzorem (także po `1.` / `a)` / `- ` z listy)
          const lead = /^(\s*(?:[-*+]\s+|\d+[.)]\s+|[a-z][.)]\s+)?)([\s\S]*)$/.exec(line)!;
          const [, prefix, rest] = lead;
          if (looksLikeFormula(rest)) return `${prefix}$${toLatex(rest)}$`;
          // wzór jako osobny fragment po dwukropku: „Zatem: 5^(2x-1) = 1/125"
          const colon = /^([^:]*:\s)(.+)$/.exec(rest);
          if (colon && looksLikeFormula(colon[2]) && isProse(colon[1])) {
            return `${prefix}${colon[1]}$${toLatex(colon[2])}$`;
          }
          return line;
        })
        .join("\n");
    })
    .join("");
}
