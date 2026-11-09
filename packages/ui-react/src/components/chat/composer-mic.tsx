import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { MicButton, type MicPhase } from "@schlessera/brain-ui-kit";

/** V1 (#3690): a hold this long opens Start; an earlier release is a tap. */
const HOLD_MS = 600;

/** How long a stray click after a hold or a cancelled hold is swallowed. */
const SWALLOW_MS = 1000;

interface ComposerMicProps {
  /** The accessible name: "Dictate", "Dictate · <service>", "Record on this device". */
  name?: string;
  /** A tap, Enter or Space. */
  onTap?: () => void;
  /**
   * A completed hold, Shift+Enter or "Talk live…". Absent: the mic has no
   * hold (M1, #3727), so a long press is a tap and no hint is drawn.
   */
  onTalkLive?: () => void;
}

/**
 * The composer's one mic (#3693): tap to dictate, hold to talk live.
 *
 * The kit's `MicButton` is presentational; this owns the hold. A press
 * fills the ring from elapsed time, and at 0.6 s the hold completes: a light
 * haptic where the device has one, then `onTalkLive`. Releasing earlier is a
 * tap, so the button's own click dictates. Leaving the mic, or a cancelled
 * pointer, ends the hold with nothing done.
 *
 * Nothing is captured during a hold: the press starts a timer and an
 * animation frame loop, and nothing else. No microphone, provider or history
 * work starts until the user picks dictation or presses Start.
 */
export function ComposerMic(p: ComposerMicProps) {
  const [phase, setPhase] = useState<MicPhase>("idle");
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  const holding = useRef(false);
  const swallow = useRef<(() => void) | null>(null);
  const latest = useRef(p);
  latest.current = p;

  function stopTimers() {
    if (timer.current !== null) clearTimeout(timer.current);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    timer.current = null;
    frame.current = null;
  }

  /**
   * After a hold completes or is cancelled, the release can still produce a
   * click (on the mic, or on whatever replaced it). That click is not a tap.
   * The next press of any kind ends the guard, so a later tap is never lost.
   */
  function swallowNextClick() {
    swallow.current?.();
    const click = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); end(); };
    const end = () => {
      window.removeEventListener("click", click, true);
      window.removeEventListener("pointerdown", end, true);
      window.removeEventListener("keydown", end, true);
      clearTimeout(expiry);
      if (swallow.current === end) swallow.current = null;
    };
    const expiry = setTimeout(end, SWALLOW_MS);
    window.addEventListener("click", click, true);
    window.addEventListener("pointerdown", end, true);
    window.addEventListener("keydown", end, true);
    swallow.current = end;
  }

  // A completed hold usually unmounts the composer (Start replaces it). The
  // click guard outlives it on purpose, and ends on its own.
  useEffect(() => stopTimers, []);

  function reset() {
    stopTimers();
    holding.current = false;
    setPhase("idle");
    setProgress(0);
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!latest.current.onTalkLive || event.button !== 0 || holding.current) return;
    // A touch is captured implicitly, to whatever it landed on: the button,
    // or the icon inside it. Release it so leaving the mic is seen, and
    // cancels the hold.
    const landed = event.target instanceof Element ? event.target : event.currentTarget;
    if (landed.hasPointerCapture?.(event.pointerId)) landed.releasePointerCapture(event.pointerId);
    // A touch's compatibility mousedown arrives after the finger lifts, and
    // would pull focus back from what the hold opened. The click that makes
    // a tap is not one of those events, and still arrives.
    if (event.pointerType === "touch") event.preventDefault();
    holding.current = true;
    const started = performance.now();
    setPhase("pressed");
    setProgress(0);
    const tick = () => {
      const fill = Math.min(1, (performance.now() - started) / HOLD_MS);
      setPhase("holding");
      setProgress(fill);
      frame.current = fill < 1 ? requestAnimationFrame(tick) : null;
    };
    frame.current = requestAnimationFrame(tick);
    timer.current = setTimeout(() => {
      stopTimers();
      holding.current = false;
      setPhase("complete");
      setProgress(1);
      swallowNextClick();
      try { navigator.vibrate?.(10); } catch { /* No haptic on this device. */ }
      latest.current.onTalkLive?.();
    }, HOLD_MS);
  }

  function onPointerUp() {
    // Released before the hold completed: the click that follows is the tap.
    if (holding.current) reset();
    else if (phase === "complete") reset();
  }

  function cancel() {
    if (!holding.current) return;
    reset();
    swallowNextClick();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" && event.shiftKey && latest.current.onTalkLive) {
      // Shift+Enter opens Start; Enter and Space stay the button's click.
      event.preventDefault();
      latest.current.onTalkLive();
    }
  }

  return (
    <MicButton
      name={p.name}
      phase={p.onTalkLive ? phase : "idle"}
      progress={progress}
      hint={!!p.onTalkLive && phase === "holding"}
      onClick={p.onTap}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={onKeyDown}
      onTalkLive={p.onTalkLive}
    />
  );
}
