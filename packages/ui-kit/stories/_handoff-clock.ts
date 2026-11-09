/**
 * The handoff clock (#3417): how long one frame's outgoing ghost outlives its
 * fade, counted in the page's own rendered frames rather than wall-clock
 * milliseconds.
 *
 * A wall-clock cap (`removed - arrived < 700`) measures the shared runner as
 * well as the component. A main-thread stall across the 600ms mark delays the
 * removal timer, the fade's own end and every frame by the same amount, so
 * the component looks slow even though no frame shows a ghost it should have
 * dropped. Counted in rendered frames, that stall costs nothing. A component
 * that genuinely holds the ghost past its fade keeps painting frames with it.
 *
 * The promise this checks is D53's: the outgoing ghost fades out over the
 * approved 600ms on its own animation clock and is gone within a few rendered
 * frames of that fade's end. The fade's length is read from its CSS animation timing at
 * arrival; its end is the browser's own `animationend`.
 */

/** D53's approved fade, in animation time. */
export const FADE_MS = 600;

/**
 * At most this many frames may render after the frame in which the fade ends.
 * The removal timer starts at the commit and the fade on a frame near it, so
 * the two end within a vsync of each other. Normally the ghost is removed
 * before its fade ends at all. The worst case observed with one CPU shared
 * with six busy loops was two frames, while a ghost held 200ms past its fade
 * renders about twelve at 60Hz.
 */
export const FRAMES_AFTER_FADE = 3;

/**
 * Liveness only: a ghost whose fade never ends must still fail. A 600ms fade
 * ends within 36 frames at 60Hz and 72 at 120Hz; a loaded runner renders fewer
 * frames, never more, so this cannot reject a slow machine.
 */
export const FRAMES_AFTER_ARRIVAL = 90;

export interface HandoffClock {
  /** The frame committed its arriving layers. */
  arrived: boolean;
  /** No ghost or outgoing layer remains in the frame. */
  removed: boolean;
  /** Wall-clock receipts for failure diagnostics only; never an oracle. */
  arrivedAt?: number;
  removedAt?: number;
  /** The longest `ghost-out` fade's end time, in animation time, as committed at arrival. */
  fadeMs?: number;
  /** Frames rendered after the fade ended, up to removal. Zero if removal came first. */
  framesAfterFade: number;
  /** Frames rendered after arrival, up to removal. */
  framesAfterArrival: number;
  /**
   * Both layers' opacity in the first rendered frame whose `ghost-out` fade
   * is running and at least a tenth through (#3755). Taken here, on the
   * page's own frames, because the story's click can resolve after the
   * whole fade on a loaded runner. Absent if no such frame rendered.
   */
  midFade?: { out: number; incoming: number; fadeTime: number };
  /** Resolves on removal, or once the ghost has outlived its fade by more than the allowance. */
  settled: Promise<void>;
  /** Re-checks the frame, for a mutation the observer has not delivered yet. */
  observe(): void;
  dispose(): void;
}

const outgoing = ".bk-ghost, .bk-ghost-out";

/**
 * Watch one frame from its arrival commit to its ghost's removal. `isArrival`
 * says when the frame has committed its real content over the outgoing ghost.
 */
export function watchHandoff(frame: HTMLElement, isArrival: (frame: HTMLElement) => boolean): HandoffClock {
  let frames = 0;
  let fadeEndedAt: number | undefined;
  let raf = 0;
  let settle!: () => void;
  const clock: HandoffClock = {
    arrived: false,
    removed: false,
    framesAfterFade: 0,
    framesAfterArrival: 0,
    settled: new Promise<void>(resolve => { settle = resolve; }),
    observe,
    dispose,
  };

  function observe() {
    if (!clock.arrived && isArrival(frame)) {
      clock.arrived = true;
      clock.arrivedAt = performance.now();
      // The story's own geometry reads flush style in this same task.
      const fades = frame.getAnimations({ subtree: true }).filter(a => (a as CSSAnimation).animationName === "ghost-out");
      if (fades.length) clock.fadeMs = Math.max(...fades.map(a => Number(a.effect?.getComputedTiming().endTime ?? Infinity)));
      raf = requestAnimationFrame(tick);
    }
    if (clock.arrived && !clock.removed && !frame.querySelector(outgoing)) {
      clock.removed = true;
      clock.removedAt = performance.now();
      clock.framesAfterFade = fadeEndedAt === undefined ? 0 : frames - fadeEndedAt;
      cancelAnimationFrame(raf);
      settle();
    }
  }

  function sampleMidFade() {
    const out = frame.querySelector(".bk-ghost-out");
    const fade = out?.getAnimations().find(a => (a as CSSAnimation).animationName === "ghost-out");
    const fadeTime = Number(fade?.currentTime ?? 0);
    if (!out || fade?.playState !== "running" || fadeTime < FADE_MS / 10) return;
    const incoming = frame.querySelector(".bk-ghost-in");
    clock.midFade = {
      out: Number(getComputedStyle(out).opacity),
      incoming: incoming ? Number(getComputedStyle(incoming).opacity) : NaN,
      fadeTime,
    };
  }

  function tick() {
    clock.framesAfterArrival = ++frames;
    if (!clock.midFade) sampleMidFade();
    if (frames > FRAMES_AFTER_ARRIVAL) return settle();
    if (fadeEndedAt !== undefined) {
      clock.framesAfterFade = frames - fadeEndedAt;
      // A ghost held past its fade fails here, without waiting for removal.
      if (clock.framesAfterFade > FRAMES_AFTER_FADE) return settle();
    }
    raf = requestAnimationFrame(tick);
  }

  function onFadeEnd(event: AnimationEvent) {
    if (!clock.arrived || clock.removed || event.animationName !== "ghost-out") return;
    // Animation events dispatch before this frame's rAF callbacks, so the frame
    // in which the fade ended is the first one counted after it.
    fadeEndedAt ??= frames;
  }

  const observer = new MutationObserver(observe);
  observer.observe(frame, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-busy"] });
  frame.addEventListener("animationend", onFadeEnd);

  function dispose() {
    observer.disconnect();
    frame.removeEventListener("animationend", onFadeEnd);
    cancelAnimationFrame(raf);
  }

  return clock;
}

