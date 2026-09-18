// skillRefs: nazwa skilla w tekście bota renderuje się jako żółta pigułka
// (jak SkillPill "Grill Me"). Wtyczka remark rozbija węzły tekstowe na
// segmenty; nazwy bieżącego bota ładuje ChatView, więc działają przed
// pierwszym otwarciem panelu skilli. Kliknięcie otwiera panel skilli.

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function remarkSkillRefs({ skills }: { skills: string[] }) {
  const unique = [...new Set(skills.map((name) => name.trim()).filter(Boolean))];
  if (!unique.length) return () => {};
  // dłuższe nazwy najpierw, żeby "Grill Me Pro" złapać przed "Grill Me"
  const names = unique.sort((a, b) => b.length - a.length).map(escapeRe);
  // Prefix is captured instead of lookbehind. Unicode boundary supports
  // Polish names and skills ending in punctuation, for example "C++".
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${names.join("|")})(?=$|[^\\p{L}\\p{N}_])`, "giu");
  // Segmenty albo null, gdy w tekście nie ma żadnej znanej nazwy.
  const split = (value: string): any[] | null => {
    const parts: any[] = [];
    let last = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value))) {
      const at = m.index + m[1].length;
      const label = m[2];
      if (at > last) parts.push({ type: "text", value: value.slice(last, at) });
      parts.push({
        type: "skillRef",
        data: { hName: "span", hProperties: { dataSkillRef: label } },
        children: [{ type: "text", value: label }] as any,
      });
      last = at + label.length;
    }
    if (!parts.length) return null;
    if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
    return parts;
  };
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        // `inlineCode` też: bot pisze nazwę skilla w backtickach i czarna
        // pigułka kodu wcina się w zdanie. Kod BEZ znanej nazwy zostaje kodem
        // (split zwraca null). Bloki ``` nigdy nie są ruszane.
        if (child.type === "text" || child.type === "inlineCode") {
          const parts = split(child.value);
          if (parts) node.children.splice(i, 1, ...parts);
        } else if (child.type !== "code") {
          walk(child);
        }
      }
    };
    walk(tree);
  };
}

/** Lista wtyczek do składowania w ChatMarkdown. */
export function withSkillRefPlugins(plugins: unknown[], skills: string[]): unknown[] {
  return skills.length ? [...plugins, [remarkSkillRefs, { skills }]] : plugins;
}
