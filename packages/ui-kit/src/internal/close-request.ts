/**
 * Close requests for a non-modal surface (#2577): Escape, Android back and
 * the other platform close gestures, as D52 N2 asks ("Esc, back, or the
 * Close control closes a panel and returns focus to its opener").
 *
 * A native modal `<dialog>` already receives close requests. A non-modal
 * panel does not: the platform mechanism is `CloseWatcher` (Chrome Android
 * 126, Samsung 28, Firefox Android 149). While armed, this keeps one watcher
 * for the surface and hands its `close` to `request`. Without `CloseWatcher`,
 * or while disarmed, an Escape keydown stands in for it.
 *
 * `request` returns whether the surface closed. When it stays open
 * (`closedBy="none"`, a dictation take that is finishing), the watcher has
 * already been spent by the platform, so a new one is armed in its place and
 * the next close request reaches this surface again.
 *
 * Arm and disarm are for drill-in history (#2582): while a panel has drill-in
 * entries above its root, its watcher is disarmed, so Android back reaches
 * `popstate` and pops one entry; at the root it is armed again. Escape keeps
 * closing the panel at every depth (D52 N2), through the keydown fallback.
 *
 * DOM coordination only, shared first-party through `/internal`: not
 * supported API.
 */

/** The platform close watcher, as far as this helper uses it. */
interface PlatformCloseWatcher {
  onclose: ((event: Event) => void) | null;
  destroy(): void;
}
type CloseWatcherConstructor = new () => PlatformCloseWatcher;

export interface CloseRequestWatch {
  /** Route close requests to the surface. A no-op while already armed. */
  arm(): void;
  /**
   * Let close requests pass to the page (Android back reaches `popstate`).
   * Escape still closes the surface through the keydown fallback.
   */
  disarm(): void;
  /** Whether close requests currently reach the surface through a watcher. */
  readonly watching: boolean;
  /** Stop for good: the watcher and the keydown fallback are removed. */
  destroy(): void;
}

export interface CloseRequestOptions {
  /**
   * Handle Escape when no watcher is armed (default true). The overlay stack
   * passes false: it keeps one document listener that hands Escape to its
   * topmost entry only, so stacked surfaces never each take it.
   */
  escape?: boolean;
  /** Start disarmed (default armed). */
  armed?: boolean;
}

function watcherConstructor(view: Window | null): CloseWatcherConstructor | null {
  const candidate = (view as (Window & { CloseWatcher?: unknown }) | null)?.CloseWatcher;
  return typeof candidate === "function" ? (candidate as CloseWatcherConstructor) : null;
}

/** Watch close requests for one open surface in `document`; destroy it on close or unmount. */
export function watchCloseRequests(document: Document, request: () => boolean, options: CloseRequestOptions = {}): CloseRequestWatch {
  const Watcher = watcherConstructor(document.defaultView);
  let armed = options.armed ?? true;
  let destroyed = false;
  let watcher: PlatformCloseWatcher | null = null;

  const create = () => {
    if (!Watcher || !armed || destroyed || watcher) return;
    const created = new Watcher();
    created.onclose = () => {
      // The platform destroys a watcher once it closes; drop our reference
      // first, so the surface's request can re-enter arm() or destroy().
      if (watcher === created) watcher = null;
      if (destroyed) return;
      const closed = request();
      if (!closed) create();
    };
    watcher = created;
  };
  const release = () => {
    const current = watcher;
    watcher = null;
    if (current) {
      current.onclose = null;
      current.destroy();
    }
  };
  const keys = (event: KeyboardEvent) => {
    // With an armed watcher, Escape is the platform's close request and
    // arrives through the watcher; handling it here too would close twice.
    if (watcher || destroyed || event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    // Prevented only when the surface closed. A refusal (a modal over it,
    // closedBy="none", a finishing take) leaves the keydown for whatever
    // takes it next: a dialog above needs it for its own cancel.
    if (request()) event.preventDefault();
  };
  if (options.escape ?? true) document.addEventListener("keydown", keys);
  create();

  return {
    arm() {
      armed = true;
      create();
    },
    disarm() {
      armed = false;
      release();
    },
    get watching() {
      return watcher !== null;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      release();
      document.removeEventListener("keydown", keys);
    },
  };
}
