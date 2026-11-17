import { watchCloseRequests, type CloseRequestWatch } from "./close-request.js";

/** DOM coordination only: each document owns one ordered overlay registry. */
interface Entry {
  id: symbol;
  modal: boolean;
  /** A close request (Escape, Android back) for this entry; returns whether it closed. */
  escape: () => boolean;
}
interface Registered extends Entry {
  /**
   * A non-modal entry's close watcher (#2577). A modal `<dialog>` receives
   * close requests natively; a non-modal surface needs one of its own.
   */
  watch: CloseRequestWatch | null;
}
const stacks = new WeakMap<Document, { entries: Registered[]; keys: (event: KeyboardEvent) => void }>();

export function registerOverlay(document: Document, entry: Entry): () => void {
  let stack = stacks.get(document);
  if (!stack) {
    const entries: Registered[] = [];
    const keys = (event: KeyboardEvent) => {
      const top = entries.at(-1);
      // A watching top entry receives Escape as the platform's close request,
      // through its watcher: taking it here as well would close twice.
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !top || top.modal || top.watch?.watching) return;
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
  // One document listener hands Escape to the topmost entry only, so the
  // watcher brings no keydown fallback of its own (`escape: false`).
  const registered: Registered = { ...entry, watch: entry.modal ? null : watchCloseRequests(document, entry.escape, { escape: false }) };
  stack.entries.push(registered);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    registered.watch?.destroy();
    const index = stack.entries.indexOf(registered);
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
