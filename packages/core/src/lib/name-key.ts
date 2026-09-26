/**
 * A document's names as exact-match search compares them (#416): its title
 * and each alias, case-folded with runs of whitespace collapsed. The indexer
 * stores these keys in `name_keys`, and search looks a whole query up there.
 */
import { caseFold } from "./case-fold.js";

export function nameKey(text: string): string {
  return caseFold(text.replace(/\s+/g, " ").trim());
}

/** A document's distinct, non-empty name keys: its title and its aliases. */
export function nameKeys(title: string, aliases: readonly string[]): string[] {
  return [...new Set([title, ...aliases].map(nameKey).filter((key) => key !== ""))];
}
