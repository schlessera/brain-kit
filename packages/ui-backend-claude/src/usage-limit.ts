/**
 * Vendored from Agent SDK 0.3.293's @alpha USAGE_LIMIT_ERROR_PREFIXES.
 * Keep the production classifier independent of that unstable export; the
 * regression suite compares these bytes against the installed SDK.
 * Warnings, transitions and org-policy notices are deliberately excluded.
 */
export const USAGE_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
];

/** Only runtime-authored, text-only limit stops can override a success. */
export function usageLimitText(message: unknown, content: unknown[]): string | null {
  if ((message as { model?: unknown } | null)?.model !== "<synthetic>") return null;
  const blocks = content as Array<{ type?: unknown; text?: unknown }>;
  if (!blocks.every(block => block.type === "text" && typeof block.text === "string")) return null;
  const text = blocks.map(block => block.text).join("").trim();
  return USAGE_LIMIT_PREFIXES.some(prefix => text.startsWith(prefix)) ? text : null;
}
