/**
 * Minimal YAML-frontmatter splitter for brain repo markdown files.
 *
 * Brain frontmatter is single-line key:value with the occasional inline
 * array (`tags: [a, b, c]`) and quoted string. We don't need a full YAML
 * parser — a small focused split keeps the bundle tiny and the behaviour
 * predictable.
 */

export interface FrontmatterField {
  key: string;
  /** Raw value as it appears in the file (quotes stripped). */
  value: string;
  /** Parsed array elements when value was `[a, b, c]`-shaped. */
  list?: string[];
}

export interface FrontmatterSplit {
  fields: FrontmatterField[];
  body: string;
}

const OPEN = /^---\r?\n/;

export function splitFrontmatter(md: string): FrontmatterSplit {
  if (!OPEN.test(md)) return { fields: [], body: md };
  // Find closing `---` on its own line after the opener.
  const afterOpen = md.replace(OPEN, "");
  const closeMatch = afterOpen.match(/\r?\n---\r?\n/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { fields: [], body: md };
  }
  const rawFrontmatter = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  const fields: FrontmatterField[] = [];
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    const raw = line.slice(sep + 1).trim();
    fields.push(parseField(key, raw));
  }
  return { fields, body };
}

function parseField(key: string, raw: string): FrontmatterField {
  // Inline array: [a, "b", c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1);
    const list = splitArray(inner).map(unquote).filter(Boolean);
    return { key, value: raw, list };
  }
  return { key, value: unquote(raw) };
}

function unquote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Split on top-level commas, respecting quoted segments. */
function splitArray(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (ch === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      const piece = buf.trim();
      if (piece) out.push(piece);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}
