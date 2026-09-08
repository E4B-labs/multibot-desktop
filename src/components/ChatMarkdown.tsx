// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, code blocks render
// as plain <pre> and nothing is cached — partial fences would poison it.
//
// multibot: matematyka. `remark-math` + `rehype-katex` w trybie MathML —
// przeglądarka rysuje wzór własnym silnikiem, więc do paczki nie wchodzi ANI
// arkusz KaTeX, ANI jego fonty. To nie jest oszczędność dla samej oszczędności:
// webui jedzie na telefon jako jeden string HTML z `baseUrl` serwera i chodzi
// przez Tora, więc każde odwołanie do zewnętrznego hosta z fontem byłoby
// pustym kwadratem zamiast wzoru. `throwOnError: false` — zły LaTeX renderuje
// się na czerwono jako źródło, nigdy nie wywraca całej wiadomości.
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { asciiMathToLatex } from "@/lib/asciiMath";
import { Check, Copy } from "lucide-react";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/cn";
import { normalizeState } from "@/lib/mascot";
import { botDisplayName } from "@/lib/botNames";
import { MausAvatar } from "./Avatar";
import { SkillRef } from "./SkillRef";
import { useStore } from "@/state/store";
// multibot (2.4): wzmianki jako chip — logika wtyczki w osobnym, testowanym pliku.
import { mentionPlugins } from "@/lib/mentions";
import { remarkBrackets } from "@/lib/brackets";
import { withSkillRefPlugins } from "@/lib/skillRefs";

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed, capped, never written while streaming
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// multibot (2.4): typ bota ze store'a — wzmianka rysuje jego awatar, więc
// potrzebuje więcej niż imienia. Sama wtyczka siedzi w `@/lib/mentions`.
type MentionBot = ReturnType<typeof useStore>["state"]["bots"][number];

function CodeBlock({ code, lang, streaming, compact }: { code: string; lang: string; streaming: boolean; compact: boolean }) {
  const polish = useLanguage() === "pl";
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (streaming) return;
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    import("shiki")
      .then((shiki) =>
        shiki.codeToHtml(code, {
          lang: lang || "text",
          theme: "github-dark-default",
        }),
      )
      .then((out) => {
        if (!alive) return;
        if (highlightCache.size >= CACHE_MAX) {
          const first = highlightCache.keys().next().value;
          if (first) highlightCache.delete(first);
        }
        highlightCache.set(key, out);
        setHtml(out);
      })
      .catch(() => {
        /* unknown language or shiki failed — the plain <pre> stays */
      });
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1">
        <span className={cn("uppercase tracking-wide text-ink-secondary", compact ? "text-[10px]" : "text-[11px]")}>{lang || "code"}</span>
        <button
          onClick={copy}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title={polish ? "Kopiuj kod" : "Copy code"}
        >
          {copied
            ? <Check size={13} className="text-success" />
            : <Copy size={13} />}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
    </div>
  );
}

/** multibot: `compact` = wariant do dymków czatu — ten sam markup, tylko własne
 * rozmiary czcionek i ikon. Wartości ustawiał właściciel iteracyjnie; obecny
 * zestaw odpowiada treści dymka 15px (13px w kodzie, wzmiankach i tabelach,
 * 16/15px w nagłówkach). Panele (GroupPanel, RoomPanel, SkillsPanel) renderują BEZ tej
 * flagi, więc zostają w dotychczasowych rozmiarach. */
function ChatMarkdownComponent({ text, streaming = false, compact = false }: { text: string; streaming?: boolean; compact?: boolean }) {
  const { state } = useStore();
  const polish = useLanguage() === "pl";
  const bots = useMemo<MentionBot[]>(() => state.bots, [state.bots]);
  const skillNames = useMemo(() => state.skills.map((skill) => skill.name), [state.skills]);
  const remarkPlugins = useMemo<any[]>(
    () => withSkillRefPlugins([...mentionPlugins(remarkGfm, bots), remarkBrackets, remarkMath], skillNames) as any[],
    [bots, skillNames],
  );
  // ratunek dla botów piszących wzory ASCII-em zamiast LaTeX-em — no-op, gdy
  // tekst już ma `$…$`. Reguła w prompcie systemowym to główna droga.
  const source = useMemo(() => asciiMathToLatex(text), [text]);
  return (
    <div
      className={cn(
        "chat-md min-w-0 [&>*+*]:mt-3",
        // wzór blokowy: własny oddech i poziomy suwak, żeby długie równanie nie
        // rozpychało dymka na telefonie. W trybie MathML KaTeX nie daje
        // `.katex-display` — jedyny uchwyt to `display="block"` na <math>
        // (pilnuje tego ChatMarkdown.math.test.ts).
        "[&_math[display='block']]:my-3 [&_math[display='block']]:block [&_math[display='block']]:overflow-x-auto [&_math[display='block']]:overflow-y-hidden [&_math[display='block']]:text-center",
        "[&_math]:font-normal [&_strong]:font-semibold [&_strong]:text-ink",
      )}
    >
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[[rehypeKatex, { output: "mathml", throwOnError: false, strict: false }]]}
        components={{
          span({ node, children }: { node?: any; children?: ReactNode }) {
            const mention = node?.properties?.dataMention ?? node?.properties?.["data-mention"];
            const bot = typeof mention === "string" ? bots.find((b) => b.name.toLowerCase() === mention.toLowerCase()) : undefined;
            if (!bot) {
              // multibot: skillRef — nazwa skilla jako żółta pigułka z ikoną
              const skillRef = node?.properties?.dataSkillRef ?? node?.properties?.["data-skill-ref"];
              if (typeof skillRef === "string") {
                return (
                  <SkillRef name={skillRef} compact={compact}>
                    {children}
                  </SkillRef>
                );
              }
              return <span>{children}</span>;
            }
            return (
              <span className="inline-flex translate-y-px items-center gap-1 rounded-full bg-raised px-2 py-0.5 align-middle text-[13px] font-medium text-ink">
                <MausAvatar color={bot.color} avatarUrl={bot.avatarUrl} shape={bot.mascotShape} state={normalizeState(bot.mascotExpression) ?? "happy"} size={16} animated={false} />
                {/* multibot: sama nazwa, bez małpki. Owal z awatarem już mówi,
                    że to bot, a „@" zostawiało dwa różne zapisy tej samej
                    rzeczy: plakietka nadawcy przy wiadomościach bot→bot
                    (PeerBadge) pokazuje „Atlas", więc pigułka też ma tak
                    pokazywać. Nazwa idzie z tego samego źródła co tam. */}
                {botDisplayName(bot, polish ? "pl" : "en")}
              </span>
            );
          },
          pre({ children }: { children?: ReactNode }) {
            // fenced code arrives as <pre><code class="language-x">…</code></pre>
            const child: any = Array.isArray(children) ? children[0] : children;
            const className: string = child?.props?.className ?? "";
            const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
            const code = String(child?.props?.children ?? "").replace(/\n$/, "");
            return <CodeBlock code={code} lang={lang} streaming={streaming} compact={compact} />;
          },
          code({ children }: { children?: ReactNode }) {
            return (
              <code className="rounded bg-inset px-1 py-px text-[13px]">{children}</code>
            );
          },
          a({ href, children }: { href?: string; children?: ReactNode }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="break-words text-accent underline decoration-accent/40 hover:decoration-accent"
              >
                {children}
              </a>
            );
          },
          table({ children }: { children?: ReactNode }) {
            return (
              <div className="my-1 overflow-x-auto rounded-lg border border-hairline/40">
                <table className={cn("w-full border-collapse", compact ? "text-[13px]" : "text-[13.5px]")}>{children}</table>
              </div>
            );
          },
          th({ children }: { children?: ReactNode }) {
            return (
              <th className="border-b border-hairline/40 bg-inset/50 px-2.5 py-2 text-left font-semibold">{children}</th>
            );
          },
          td({ children }: { children?: ReactNode }) {
            return <td className="border-b border-hairline/20 px-2.5 py-2 align-top">{children}</td>;
          },
          ul({ children }: { children?: ReactNode }) {
            return <ul className="list-disc space-y-1.5 pl-[1.35rem] marker:text-ink-secondary">{children}</ul>;
          },
          ol({ children }: { children?: ReactNode }) {
            return <ol className="list-decimal space-y-1.5 pl-[1.35rem] marker:text-ink-secondary">{children}</ol>;
          },
          li({ children }: { children?: ReactNode }) {
            return <li className="[&>*+*]:mt-2 leading-relaxed">{children}</li>;
          },
          p({ children }: { children?: ReactNode }) {
            return <p className="leading-relaxed">{children}</p>;
          },
          h1({ children }: { children?: ReactNode }) {
            return <div className="mt-4 text-[16px] font-semibold">{children}</div>;
          },
          h2({ children }: { children?: ReactNode }) {
            return <div className={cn("mt-4 font-semibold", compact ? "text-[15px]" : "text-[15.5px]")}>{children}</div>;
          },
          h3({ children }: { children?: ReactNode }) {
            return <div className="mt-3 font-semibold">{children}</div>;
          },
          h4({ children }: { children?: ReactNode }) {
            return <div className="mt-3 font-semibold">{children}</div>;
          },
          blockquote({ children }: { children?: ReactNode }) {
            return (
              <blockquote className="border-l-2 border-accent/40 py-0.5 pl-3 text-ink-secondary [&>*+*]:mt-2">{children}</blockquote>
            );
          },
          hr() {
            return <hr className="my-4 border-hairline/40" />;
          },
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
