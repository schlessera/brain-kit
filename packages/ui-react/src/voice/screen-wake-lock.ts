/**
 * Holds a W3C Screen Wake Lock (`navigator.wakeLock.request("screen")`) while
 * a voice interaction is active so device idle-lock timers do not dim or sleep
 * the screen mid-utterance or mid-conversation.
 *
 * Browsers automatically release a wake lock when the page becomes hidden, so
 * this controller listens to `visibilitychange` while held and re-acquires on
 * return to `"visible"`. A generation counter ensures any sentinel resolving
 * after `release()` or a newer `acquire()` cycle is released immediately and
 * never leaks.
 *
 * Degrades silently when the API is unavailable or rejected (for example in
 * Low Power Mode, an insecure context, or a hidden document).
 */
export interface ScreenWakeLock {
  acquire(): void;
  release(): void;
}

function hasWakeLockApi(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "wakeLock" in navigator &&
    typeof navigator.wakeLock?.request === "function"
  );
}

export function createScreenWakeLock(): ScreenWakeLock {
  let held = false;
  let sentinel: WakeLockSentinel | null = null;
  let requesting = false;
  let generation = 0;
  let listening = false;

  const request = () => {
    if (!held || sentinel || requesting || !hasWakeLockApi()) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return;
    }
    const own = generation;
    requesting = true;
    try {
      void Promise.resolve(navigator.wakeLock.request("screen")).then(
        (next) => {
          if (own === generation) requesting = false;
          if (!held || own !== generation) {
            void next.release().catch(() => {});
            return;
          }
          if (next.released) return;
          sentinel = next;
          next.addEventListener(
            "release",
            () => {
              if (sentinel === next) sentinel = null;
            },
            { once: true },
          );
        },
        () => {
          if (own === generation) requesting = false;
        },
      );
    } catch {
      if (own === generation) requesting = false;
    }
  };

  const onVisibilityChange = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      held &&
      !sentinel
    ) {
      request();
    }
  };

  return {
    acquire() {
      if (held) return;
      held = true;
      if (!hasWakeLockApi()) return;
      if (typeof document !== "undefined" && !listening) {
        document.addEventListener("visibilitychange", onVisibilityChange);
        listening = true;
      }
      request();
    },
    release() {
      if (!held && !sentinel && !listening) return;
      held = false;
      generation++;
      requesting = false;
      if (listening && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        listening = false;
      }
      if (sentinel) {
        const current = sentinel;
        sentinel = null;
        void current.release().catch(() => {});
      }
    },
  };
}
