/** Provider status text that belongs to the harness, not the conversation. */
export function isContextCompactionNotice(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  return /^(?:compacting(?: (?:conversation|context))?|(?:conversation|context) compacted)[.!…]*$/i.test(normalized);
}
