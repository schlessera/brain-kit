/**
 * Single-letter shortcuts, focus-scoped (D36).
 *
 * The design's rule: `a` / `d` / `s` act only while the card they belong to
 * holds focus; `j` / `k` only inside the focused list; anything global takes
 * a modifier. So a letter is a shortcut exactly when it arrives bare — no
 * modifier — and not from something the reader is typing into. Both checks
 * live here so every list and card applies the same ones.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The letter a keydown means as a shortcut, lowercase, or `null` when it is
 * not one: a modifier is held, the key is not a single character, or the
 * reader is typing into a field.
 */
export function singleKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key.length !== 1) return null;
  if (isEditableTarget(event.target)) return null;
  return event.key.toLowerCase();
}

/**
 * Where focus goes once a card is decided or dismissed: the next card in
 * document order, else the previous one, else the fallback — the composer
 * for an in-chat approval, the page heading for an inbox. Called BEFORE the
 * card leaves the DOM, so the neighbours are still where they were.
 */
export function focusAfterDecision(current: Element, cardSelector: string, fallbackSelector: string): void {
  const cards = [...document.querySelectorAll<HTMLElement>(cardSelector)];
  const here = cards.indexOf(current as HTMLElement);
  const next = cards[here + 1] ?? cards[here - 1];
  const target = next ?? document.querySelector<HTMLElement>(fallbackSelector);
  target?.focus();
}
