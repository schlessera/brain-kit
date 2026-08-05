/**
 * Best-effort markdown → plain text for sharing. Keeps list structure
 * (lines starting with "- ") and headings (as bare lines), drops syntax.
 *
 * Not a full markdown parser; intended for short snippets pasted into
 * messengers. For correctness we'd want to render to HTML and grab
 * textContent, but that requires a DOM round-trip.
 */
export function stripMarkdown(md: string): string {
  let s = md;

  // Code fences — keep contents, drop the ``` and language hint
  s = s.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, (_m, body) => body);
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Images: ![alt](url) → alt (or just drop if no alt)
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => alt || "");
  // Links: [text](url) → text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    return text === url ? text : `${text} (${url})`;
  });
  // Bold / italic / strike — drop markers, keep text
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
  s = s.replace(/(\*|_)(.+?)\1/g, "$2");
  s = s.replace(/~~(.+?)~~/g, "$1");
  // Headings: # text → text
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Blockquotes: leading "> "
  s = s.replace(/^>\s?/gm, "");
  // Horizontal rules
  s = s.replace(/^---+$/gm, "");
  // Wikilinks [[slug]] or [[slug|label]] → label or slug
  s = s.replace(/\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g, (_m, target, label) => label?.trim() ?? target.trim());
  // Collapse 3+ blank lines to 2
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}
