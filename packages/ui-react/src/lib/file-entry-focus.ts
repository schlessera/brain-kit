import type { BrainUiRoot } from "../root.js";

/** Ephemeral DOM ownership, never an auth snapshot or persisted return path. */
type FileEntry = { opener: HTMLElement; fallback: HTMLElement | null; keyboard: boolean; heading: HTMLElement | null; epoch: number; release: () => void };
const entries = new WeakMap<BrainUiRoot, FileEntry>();

export function forgetFileEntry(root: BrainUiRoot): void {
  const entry = entries.get(root);
  entries.delete(root);
  entry?.release();
}

export function rememberFileEntry(root: BrainUiRoot, opener: HTMLElement, keyboard: boolean): void {
  forgetFileEntry(root);
  const entry: FileEntry = { opener, fallback: opener.closest("p, li, article"), keyboard, heading: null, epoch: root.authLock.epoch(), release: () => {} };
  entries.set(root, entry);
  // Drop even detached DOM references at the auth boundary. A sign-in cannot
  // recover this entry or turn it into cross-account navigation context.
  entry.release = root.authLock.state.subscribe(state => { if (state.phase !== "active") forgetFileEntry(root); });
}

export function hasFileEntry(root: BrainUiRoot): boolean { return entries.has(root); }

export function focusFileEntryHeading(root: BrainUiRoot, heading: HTMLElement | null): void {
  const entry = entries.get(root);
  if (!entry?.keyboard || entry.epoch !== root.authLock.epoch() || !heading || entry.heading === heading) return;
  const previous = entry.heading;
  entry.heading = heading;
  // The enclosing destination overlay sets its initial focus later in the
  // same layout commit. Land on the reading title after that, not before it.
  queueMicrotask(() => {
    if (entries.get(root) !== entry || entry.heading !== heading || entry.epoch !== root.authLock.epoch() || !heading.isConnected || heading.closest("[inert]")) return;
    // Responsive panes can be replaced after the opener has already landed.
    // Retain that keyboard entry, but leave an independently selected control
    // outside Files alone. Data updates reuse the same heading and never land.
    const active = heading.ownerDocument.activeElement;
    if (previous && active !== heading.ownerDocument.body && !active?.closest("[data-panel=Files]")) return;
    heading.focus({ preventScroll: true });
  });
}

/** Called after the closing commit/inert release; expired words remain inert. */
export function takeFileEntryTarget(root: BrainUiRoot): HTMLElement | null {
  const entry = entries.get(root);
  forgetFileEntry(root);
  if (!entry || entry.epoch !== root.authLock.epoch() || root.authLock.state.getState().phase !== "active") return null;
  const usable = (node: HTMLElement | null): node is HTMLElement => !!node?.isConnected && !node.closest("[inert]") && !node.matches(":disabled, [aria-disabled='true']");
  if (usable(entry.opener)) return entry.opener;
  const target = usable(entry.fallback) ? entry.fallback : document.querySelector<HTMLElement>("textarea[data-composer], [data-composer] textarea, [data-chat-heading]");
  if (!usable(target)) return null;
  if (!target.hasAttribute("tabindex") && !target.matches("textarea, input, button, a[href]")) target.tabIndex = -1;
  return target;
}
