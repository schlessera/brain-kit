/**
 * The text parts of a runtime content array (a tool result, a message), for
 * the backends' displays, safety records and prompt matching.
 */

/**
 * @experimental Backend toolkit; may change before 1.0.
 *
 * The `text` of every part whose `type` is `"text"` and whose `text` is a
 * string, in order. Anything else, including a non-array, yields no parts.
 */
export function textParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content as unknown[]) {
    if (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts;
}

/**
 * @experimental Backend toolkit; may change before 1.0.
 *
 * {@link textParts} joined with `separator`. The separator is the call site's:
 * a site whose text is compared with what was sent keeps the one it was sent with.
 */
export function textOfParts(content: unknown, separator: string): string {
  return textParts(content).join(separator);
}
