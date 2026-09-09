// Podświetlanie składni w wersji „tylko to, co widać w czacie".
//
// Po co osobny plik: `import("shiki")` ciągnie pakiet PEŁNY — komplet ~220
// gramatyk i ~70 motywów. `viteSingleFile` wkleja to do jednego index.html,
// więc interfejs urósł do 11,7 MB, a WebView na Androidzie dostawał go jako
// string przez `loadDataWithBaseURL`. Chromium koduje taki string do base64
// (11,7 MB → 15,8 MB w jednej tablicy) i telefon padał na starcie:
//   OutOfMemoryError: Failed to allocate a 15771976 byte allocation
// Zapowiedziane w scripts/bundle-webui.mjs jako „gdy zacznie boleć: przytnij
// shiki do kilku języków". Zabolało.
//
// Silnik regexpów: `createJavaScriptRegexEngine`, nie oniguruma. Oniguruma to
// dodatkowe 600 KB WASM-a, którego build jednoplikowy i tak nie umie dołożyć
// (osobny plik obok index.html = 404 w WebView). Wszystkie języki z listy
// kompilują się na silniku JS — sprawdzone, więc bez `forgiving`: gdyby dopisany
// kiedyś język się nie skompilował, ma to być widać jako brak kolorowania,
// a nie ciche gubienie połowy wzorców.
//
// Język spoza tej listy rzuca `ShikiError`, ChatMarkdown to łapie i zostaje
// zwykły <pre> — dokładnie to samo, co dla nieznanego języka wcześniej.
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const THEME = "github-dark-default";

// Zapamiętany jest tylko udany start. Gdyby pamięć akurat się skończyła — a to
// jest aplikacja, która przed chwilą padała na OOM — zapamiętana odrzucona
// obietnica wyłączyłaby kolorowanie do końca sesji, po cichu, bo ChatMarkdown
// łyka błąd. Więc przy porażce zerujemy i następny blok kodu próbuje znowu.
let pending: Promise<HighlighterCore> | null = null;

const highlighter = () =>
  (pending ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import("@shikijs/themes/github-dark-default")],
    // Aliasy (js, py, sh, md, dockerfile…) niesie sama gramatyka, więc nie ma
    // ich tutaj. Dopisanie języka = jedna linia + kilkadziesiąt KB w paczce;
    // przed dopisaniem sprawdź `npm run webui`, który pilnuje limitu rozmiaru.
    langs: [
      import("@shikijs/langs/typescript"),
      import("@shikijs/langs/tsx"),
      import("@shikijs/langs/javascript"),
      import("@shikijs/langs/jsx"),
      import("@shikijs/langs/json"),
      import("@shikijs/langs/shellscript"),
      import("@shikijs/langs/python"),
      import("@shikijs/langs/html"),
      import("@shikijs/langs/css"),
      import("@shikijs/langs/markdown"),
      import("@shikijs/langs/yaml"),
      import("@shikijs/langs/sql"),
      import("@shikijs/langs/diff"),
      import("@shikijs/langs/rust"),
      import("@shikijs/langs/go"),
      import("@shikijs/langs/java"),
      import("@shikijs/langs/c"),
      import("@shikijs/langs/xml"),
      import("@shikijs/langs/toml"),
      import("@shikijs/langs/ini"),
      import("@shikijs/langs/docker"),
      import("@shikijs/langs/powershell"),
    ],
  }).catch((err) => {
    pending = null;
    throw err;
  }));

/** Zwraca HTML z kolorowaniem albo rzuca — wołający zostawia wtedy goły <pre>. */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const shiki = await highlighter();
  return shiki.codeToHtml(code, { lang, theme: THEME });
}
