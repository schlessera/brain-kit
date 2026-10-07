import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { color, font } from "../tokens.js";

/**
 * Ghost text: the loading state (#1116), and the only thing in the kit that
 * draws one.
 *
 * A ghost is blurred text set in the same type role, size and length as the
 * content it stands in for, so it has that content's shape and the layout
 * does not move when the content arrives. The kit spectrum sweeps through it
 * (`.bk-ghost` in `tokens.css`); when that item's data resolves the ghost
 * cross-fades out under the real text over 600ms.
 *
 * What this file owns, so no component re-derives it:
 *   - the role → font, size and blur map;
 *   - `aria-hidden` — a ghost is decoration, and the container it sits in says
 *     `aria-busy` instead;
 *   - `ghostString`, the seeded glyphs;
 *   - the handoff: `useArrival` notices a loading → ready flip and `Ghosted`
 *     draws one slot through it.
 *
 * The frame is never ghosted: borders, radii, padding, icons and the status
 * dot slot are final from the first frame. Only text is.
 */

export type GhostRole = "sans" | "mono" | "title";

/** One ghost line: how many characters, in which type role. */
export interface GhostSpec {
  length: number;
  role: GhostRole;
  /** Font size in px. Defaults per role: sans 12, mono 11, title 19. */
  size?: number;
}

/** How long the handoff runs, in ms. The `.bk-ghost-in`/`-out` duration. */
export const HANDOFF_MS = 600;

export const DEFAULT_SIZE: Record<GhostRole, number> = { sans: 12, mono: 11, title: 19 };

/**
 * The blur, by role and size. A ghost blurred too little reads as text in a
 * language you cannot read; too much and it stops having the shape of a line.
 * The amounts are the design's: sans 13px and up 3px (3.2 for the 13.5px
 * answer prose), sans below 13 2.6px, mono 2.4px (2.2 for 9.5px meta).
 */
export function ghostBlur(role: GhostRole, size = DEFAULT_SIZE[role]): number {
  if (role === "title") return 3.2;
  if (role === "mono") return size <= 9.5 ? 2.2 : 2.4;
  if (size >= 13.5) return 3.2;
  if (size >= 13) return 3;
  return 2.6;
}

/** The role's family. Weight and line height stay the caller's: they belong to
 * the line the ghost replaces, not to the ghost. */
export function ghostFamily(role: GhostRole): string {
  return role === "mono" ? font.mono : role === "title" ? font.display : font.body;
}

/* ── Seeded glyphs ─────────────────────────────────────────────────────── */

function hash(seed: string | number): number {
  // FNV-1a, so a seed is any item key and the same key is the same ghost.
  let h = 0x811c9dc5;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function random(seed: string | number): () => number {
  // mulberry32
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Letters at roughly English frequency, so a ghost line is as wide as a line
 * of real text of the same length and wraps where it would: uniform letters
 * over-sample the wide ones (m, w) and the ghost runs long. */
const LETTERS = "eeeeeeeeeeeettttttttaaaaaaaaoooooooiiiiiiinnnnnnnsssssshhhhhhrrrrrrddddllllcccuuummwwffggyyppbbvk";

/**
 * Exactly `length` characters of seeded words, each 2-9 characters long, the
 * same for the same seed every time — the seed is the item's key, so a ghost
 * never flickers between renders.
 *
 * `path` joins the words with `/` and puts a `.` before the last one, so a
 * mono ghost standing in for a path has a path's shape. Blurred, it is the
 * separators' rhythm that reads, not the letters.
 */
export function ghostString(length: number, seed: string | number, path = false): string {
  const n = Math.max(0, Math.floor(length));
  const next = random(seed);
  const words: string[] = [];
  let left = n;
  while (left > 0) {
    // The last word takes what is left; otherwise leave room for a separator
    // and a word of at least two, so no word is ever a single letter.
    const w = left <= 9 ? left : 2 + Math.floor(next() * (Math.min(9, left - 3) - 1));
    let word = "";
    for (let i = 0; i < w; i++) word += LETTERS[Math.floor(next() * LETTERS.length)];
    words.push(word);
    left -= w + 1;
  }
  if (!path) return words.join(" ");
  // Same lengths, path separators: `/` between segments, `.` before the last.
  return words.reduce((out, word, i) => (i === 0 ? word : `${out}${i === words.length - 1 ? "." : "/"}${word}`), "");
}

/* ── One ghost ─────────────────────────────────────────────────────────── */

export interface GhostTextProps {
  role: GhostRole;
  /** How many characters it stands in for. */
  length: number;
  /** The item's key. The same seed is the same glyphs. */
  seed: string | number;
  size?: number;
  /** Overrides the role's blur. */
  blur?: number;
  /** Stagger, in seconds: +0.1 per line in a card, plus the item's list offset. */
  delay?: number;
  /** `false` holds the ghost still: a static base fill, still blurred. */
  animate?: boolean;
  /** `line` sets the ghost as one non-wrapping line clipped to the given
   * width, rather than as text that wraps where the real text would. */
  width?: string;
  /** Glyphs with a path's separators. Mono only. */
  path?: boolean;
}

/**
 * One ghost: one element per text slot, never one per word. Inline, so it
 * wraps exactly where text of the same length and font would, and takes the
 * line box of the element it sits in.
 */
export function GhostText(p: GhostTextProps) {
  const size = p.size ?? DEFAULT_SIZE[p.role];
  const style: CSSProperties = {
    fontFamily: ghostFamily(p.role),
    fontSize: size,
    filter: `blur(${p.blur ?? ghostBlur(p.role, size)}px)`,
    animationDelay: p.delay ? `${p.delay.toFixed(2)}s` : undefined,
    ...(p.width
      ? { display: "inline-block", width: p.width, maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", verticalAlign: "top" }
      : null),
  };
  return (
    <span
      aria-hidden="true"
      className="bk-ghost"
      data-ghost-role={p.role}
      data-still={p.animate === false ? "" : undefined}
      style={style}
    >
      {ghostString(p.length, p.seed, p.path === true && p.role === "mono")}
    </span>
  );
}

/* ── The handoff ───────────────────────────────────────────────────────── */

/**
 * True for the 600ms after `loading` turns false, so the item can draw its
 * ghost under the arriving text. Per item: each list row calls it with its
 * own flag, so each one hands off when ITS data lands.
 *
 * Derived during render rather than in an effect, so the first ready frame
 * already carries the outgoing ghost — an effect would paint one frame of bare
 * text first, and the ghost would blink back over it.
 */
export function useArrival(loading: boolean): boolean {
  const [prev, setPrev] = useState(loading);
  const [arriving, setArriving] = useState(false);
  if (prev !== loading) {
    setPrev(loading);
    setArriving(!loading);
  }
  useEffect(() => {
    if (!arriving) return;
    const timer = setTimeout(() => setArriving(false), HANDOFF_MS);
    return () => clearTimeout(timer);
  }, [arriving]);
  return arriving;
}

const OVERLAY: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  pointerEvents: "none",
};

/** The incoming layer while it fades in: positioned, so it paints over the
 * outgoing ghost that precedes it — two positioned siblings with no z-index
 * paint in document order, and in-flow text would paint UNDER the overlay. */
export const INCOMING: CSSProperties = { position: "relative" };

/**
 * One text slot through all three states: the ghost while loading, the real
 * text over the outgoing ghost while arriving, and the real text alone after.
 *
 * The slot's parent must be `position: relative` — the outgoing ghost is laid
 * under the text rather than beside it, so it costs no space and leaves none
 * behind when it goes. The real text keeps one wrapper from arrival on, so
 * ending the handoff changes a class, not the tree: nothing under it remounts.
 */
export function Ghosted(p: { loading: boolean; arriving: boolean; ghost: GhostTextProps; children?: ReactNode }) {
  if (p.loading) return <GhostText {...p.ghost} />;
  return (
    <>
      {p.arriving ? (
        <span aria-hidden="true" className="bk-ghost-out" style={OVERLAY}>
          <GhostText {...p.ghost} />
        </span>
      ) : null}
      <span className={p.arriving ? "bk-ghost-in" : undefined} style={p.arriving ? INCOMING : undefined}>
        {p.children}
      </span>
    </>
  );
}

/* ── Frame slots ───────────────────────────────────────────────────────── */

/** The status-dot slot before the state is known: an `edge` dot, so the row's
 * geometry is final and its tone waits for the data. */
export function GhostDot({ size = 7 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-ghost-slot="dot"
      style={{ width: size, height: size, borderRadius: "50%", flex: "none", display: "inline-block", background: color.edge }}
    />
  );
}

/** An icon that depends on the data — a kind, a file type — before the data
 * says which: a 14px outline slot in the icon's place. */
export function GhostIconSlot({ size = 14 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-ghost-slot="icon"
      style={{
        width: size,
        height: size,
        flex: "none",
        display: "inline-block",
        boxSizing: "border-box",
        border: `1px solid ${color.edge}`,
        borderRadius: 4,
      }}
    />
  );
}

/**
 * The length a ghost stands in for, in the issue's order: the value this item
 * showed last time (a re-fetch), else a hint the caller has (a listing's file
 * name, a snippet length), else the component's typical length.
 */
export function ghostLength(previous: number | undefined, hint: number | undefined, typical: number): number {
  return previous ?? hint ?? typical;
}

/**
 * What this item last showed — its text lengths, and any frame fact a ghost
 * needs, like a file row's kind — for the next time it loads: every
 * committed ready render records them, mid-handoff included, so a re-fetch
 * that starts before the last handoff ended still sizes from the newest data.
 * Written on commit, never during render.
 */
export function useLastLengths<T extends object>(ready: boolean, lengths: T): Partial<T> {
  const last = useRef<Partial<T>>({});
  useLayoutEffect(() => {
    if (ready) last.current = lengths;
  });
  return last.current;
}

/**
 * The ghost lengths as they were while loading, held through the handoff: the
 * outgoing ghost is the one that was on screen, not one re-sized from the data
 * that just replaced it. Held on commit, so a loading render React abandons
 * never becomes the ghost that fades out.
 */
export function useLoadingValue<T>(loading: boolean, value: T): T {
  const held = useRef(value);
  useLayoutEffect(() => {
    if (loading) held.current = value;
  });
  return loading ? value : held.current;
}
