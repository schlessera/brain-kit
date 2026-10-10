/** DOM coordination only: each document owns one ordered overlay registry. */
interface Entry {
  id: symbol;
  modal: boolean;
  escape: () => void;
}
const stacks = new WeakMap<Document, { entries: Entry[]; keys: (event: KeyboardEvent) => void }>();

export function registerOverlay(document: Document, entry: Entry): () => void {
  let stack = stacks.get(document);
  if (!stack) {
    const entries: Entry[] = [];
    const keys = (event: KeyboardEvent) => {
      const top = entries.at(-1);
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !top || top.modal) return;
      event.preventDefault();
      event.stopPropagation();
      top.escape();
    };
    stack = { entries, keys };
    stacks.set(document, stack);
    document.addEventListener("keydown", keys);
  }
  // Nested layout effects run child-first when opened in one commit. Keep
  // this same order as showModal(): the parent opens last and owns the top layer.
  stack.entries.push(entry);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = stack.entries.indexOf(entry);
    if (index !== -1) stack.entries.splice(index, 1);
    if (!stack.entries.length) {
      document.removeEventListener("keydown", stack.keys);
      stacks.delete(document);
    }
  };
}

export function isTopmost(document: Document, id: symbol): boolean {
  return stacks.get(document)?.entries.at(-1)?.id === id;
}
