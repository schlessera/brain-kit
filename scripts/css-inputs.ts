/** Supported literal CSS build edges. Syntax outside this subset stays unresolved.
 * Comments and ordinary strings cannot manufacture directives. Escaped paths,
 * globs, remote URLs and dynamic scan configuration deliberately fail fresh. */
export function cssInputs(css: string): {
  inputs: { kind: "import" | "source" | "url"; expression: string; value?: string }[];
  unsupported: boolean;
} {
  const inputs: { kind: "import" | "source" | "url"; expression: string; value?: string }[] = [];
  let unsupported = false;
  const literal = (text: string): string | undefined => {
    const match = /^(?:"([^"\\]*)"|'([^'\\]*)')$/.exec(text.trim());
    const value = match?.[1] ?? match?.[2];
    return value && !/[\r\n\0*?#[\]{}]/.test(value) ? value : undefined;
  };
  const packagePath = /^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+(?:\/[a-z0-9_.-]+)*$/i;
  for (let i = 0; i < css.length;) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) { unsupported = true; break; }
      if (/[\w@-]/.test(css[i - 1] ?? "") && /[\w(-]/.test(css[end + 2] ?? "")) unsupported = true;
      i = end + 2; continue;
    }
    if (css[i] === '"' || css[i] === "'") {
      const quote = css[i++]; let closed = false;
      while (i < css.length) { if (css[i] === "\\") i += 2; else if (css[i++] === quote) { closed = true; break; } }
      if (!closed) unsupported = true;
      continue;
    }
    const directive = /^@(import|source|reference|plugin|config)\b/i.exec(css.slice(i));
    if (directive) {
      const start = i; let quote = "", depth = 0;
      i += directive[0].length;
      const valueStart = i;
      for (; i < css.length; i++) {
        const char = css[i]!;
        if (char === "\\") { i++; continue; }
        if (quote) { if (char === quote) quote = ""; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === "(") depth++;
        if (char === ")") depth--;
        if (char === ";" && depth === 0) break;
        if (char === "{" || char === "}" || depth < 0) break;
      }
      const body = css.slice(valueStart, i).trim(), expression = css.slice(start, i + 1);
      directive[1] = directive[1]!.toLowerCase();
      if (css[i] !== ";" || quote || depth || !["import", "source"].includes(directive[1]!)) unsupported = true;
      else {
        const kind = directive[1] as "import" | "source";
        const value = literal(body);
        // Tailwind package imports may explicitly disable implicit scanning.
        // Other qualifiers remain unknown, even when a declaration exists.
        if (value && (value.startsWith(".") || packagePath.test(value))) inputs.push({ kind, expression, value });
        else if (kind === "import" && /\s+source\(none\)$/.test(body)) {
          const dependency = literal(body.replace(/\s+source\(none\)$/, ""));
          if (dependency && packagePath.test(dependency)) inputs.push({ kind, expression, value: dependency });
          else unsupported = true;
        } else unsupported = true;
      }
      i++; continue;
    }
    const atRule = /^@([a-z-]+)/i.exec(css.slice(i));
    if (atRule) {
      if (!new Set(["charset", "layer", "theme", "utility", "variant", "custom-variant", "apply", "media", "supports", "container", "scope", "keyframes", "starting-style", "font-face", "property", "page", "counter-style", "namespace"]).has(atRule[1]!.toLowerCase())) unsupported = true;
      i += atRule[0].length; continue;
    }
    const url = /^url\s*\(/i.exec(css.slice(i));
    if (url && (i === 0 || !/[\w-]/.test(css[i - 1]!))) {
      const start = i, end = css.indexOf(")", i + url[0].length);
      if (end < 0) { unsupported = true; break; }
      const body = css.slice(i + url[0].length, end).trim();
      const value = literal(body) ?? (/^\.[^\s'"()\\*?#[\]{}]+$/.test(body) ? body : undefined);
      if (value) inputs.push({ kind: "url", expression: css.slice(start, end + 1), value });
      else unsupported = true;
      i = end + 1; continue;
    }
    // Escaped identifiers may hide input-bearing CSS constructs.
    if (css[i] === "\\") unsupported = true;
    i++;
  }
  return { inputs, unsupported };
}
