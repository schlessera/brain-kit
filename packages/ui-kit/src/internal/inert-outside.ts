/** Ref-count only the inert marks we own; page-owned inert is never changed. */
const counts = new WeakMap<HTMLElement, number>();
const walkers = new WeakMap<Document, Set<() => void>>();
const modals = new WeakMap<Document, Set<HTMLElement>>();

/** Release our ancestor marks before showModal/focus, without waiting for the observer. */
export function keepModalLive(modal: HTMLElement): () => void {
  const doc = modal.ownerDocument;
  let live = modals.get(doc);
  if (!live) { live = new Set(); modals.set(doc, live); }
  live.add(modal);
  for (const refresh of walkers.get(doc) ?? []) refresh();
  return () => {
    live.delete(modal);
    for (const refresh of walkers.get(doc) ?? []) refresh();
  };
}

export function inertOutside(panel: HTMLElement, keepLive = "[data-bk-keep-live]"): () => void {
  const doc = panel.ownerDocument;
  const marked = new Set<HTMLElement>();
  let released = false;
  function unmark(element: HTMLElement) {
    const count = counts.get(element)! - 1;
    if (count > 0) counts.set(element, count);
    else { counts.delete(element); element.inert = false; }
    marked.delete(element);
  }
  function refresh() {
    if (released) return;
    const next = new Set<HTMLElement>();
    observer.disconnect();
    function walk(element: HTMLElement) {
      if (element.matches(keepLive) || modals.get(doc)?.has(element)) return;
      const containsModal = [...modals.get(doc) ?? []].some(modal => element.contains(modal));
      if (element.querySelector(keepLive) || containsModal) {
        observer.observe(element, { childList: true });
        for (const child of element.children) walk(child as HTMLElement);
      } else next.add(element);
    }
    for (let here = panel; here.parentElement; here = here.parentElement) {
      observer.observe(here.parentElement, { childList: true });
      for (const sibling of here.parentElement.children) {
        if (sibling !== here) walk(sibling as HTMLElement);
      }
      if (here.parentElement === doc.body) break;
    }
    // Release ancestors before applying the narrower marks around a new modal.
    for (const element of marked) if (!next.has(element)) unmark(element);
    for (const element of next) {
      if (marked.has(element)) continue;
      const count = counts.get(element);
      if (count === undefined && element.inert) continue;
      counts.set(element, (count ?? 0) + 1);
      element.inert = true;
      marked.add(element);
    }
  }
  const observer = new doc.defaultView!.MutationObserver(refresh);
  let active = walkers.get(doc);
  if (!active) { active = new Set(); walkers.set(doc, active); }
  active.add(refresh);
  refresh();
  return () => {
    if (released) return;
    released = true;
    observer.disconnect();
    active.delete(refresh);
    for (const element of marked) unmark(element);
  };
}
