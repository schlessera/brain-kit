/**
 * Edge probes for extended hit targets (#3252, `.bk-hit`).
 *
 * The design-kit rule: a 44px target is not a 44px box, and a target is checked
 * with `elementFromPoint` at its EDGES, where a neighbour's reach would steal
 * it. A centre always passes.
 *
 * A probe point sits `inset` px inside each edge of the control's target. The
 * target is its paint, grown to `floor` on each axis about the paint's centre:
 * pass 44 for a reaching control under a coarse pointer, and 0 for paint only.
 *
 * The default inset is 1px, not 0.5px: Chromium's `elementFromPoint` rounds the
 * point to whole pixels, so a probe 0.5px inside an edge at a fractional
 * coordinate can land on a neighbour that merely touches it. Measured: a
 * Button ending at y=414 next to a heading starting at 414 lost a probe at
 * 413.5 to the heading.
 */
export type Edge = "top" | "right" | "bottom" | "left";

export function targetRect(el: Element, floor: number) {
  const r = el.getBoundingClientRect();
  const width = Math.max(r.width, floor), height = Math.max(r.height, floor);
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  return { left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2, x, y, width, height };
}

/** A short name for whatever a probe hit, so a theft names the thief. */
export function describeHit(hit: Element | null): string {
  if (!hit) return "nothing";
  const owner = hit.closest<HTMLElement>('button, a[href], summary, input, select, textarea, label, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"]');
  if (!owner) return `<${hit.tagName.toLowerCase()}>`;
  const name = owner.getAttribute("aria-label") ?? owner.textContent?.trim().slice(0, 40) ?? "";
  return `${owner.getAttribute("role") ?? owner.tagName.toLowerCase()} "${name}"`;
}

/** What each edge probe hits: `"self"` when the control owns it. */
export function edgeOwners(el: HTMLElement, floor: number, inset = 1): Record<Edge, string> {
  const t = targetRect(el, floor);
  const points: Record<Edge, [number, number]> = {
    top: [t.x, t.top + inset],
    right: [t.right - inset, t.y],
    bottom: [t.x, t.bottom - inset],
    left: [t.left + inset, t.y],
  };
  const result = {} as Record<Edge, string>;
  for (const edge of Object.keys(points) as Edge[]) {
    const [x, y] = points[edge];
    const hit = document.elementFromPoint(x, y);
    result[edge] = hit && (hit === el || el.contains(hit)) ? "self" : describeHit(hit);
  }
  return result;
}

export const OWNED: Record<Edge, string> = { top: "self", right: "self", bottom: "self", left: "self" };

/** Whether the native pointer premise extends `.bk-hit` targets. */
export const coarsePointer = () => matchMedia("(any-pointer: coarse)").matches;

/**
 * Every enabled interactive element inside `scope`, each with the floor its
 * own target is held to: 44 for a `.bk-hit` control under a coarse pointer,
 * otherwise its paint. Probing them all checks both halves of the rule: the
 * reaching control owns its edges, and every neighbour still owns its own.
 */
export function probeScope(scope: ParentNode): { name: string; owners: Record<Edge, string> }[] {
  const coarse = coarsePointer();
  const controls = [...scope.querySelectorAll<HTMLElement>('button, a[href], summary, input, select, textarea, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"]')]
    .filter(el => !el.matches(":disabled, [aria-disabled='true']") && getComputedStyle(el).pointerEvents !== "none")
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    // A control nested inside another control is probed through its owner.
    .filter((el, _, all) => !all.some(other => other !== el && other.contains(el)));
  return controls.map(el => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return { name: describeHit(el), owners: edgeOwners(el, coarse && el.classList.contains("bk-hit") ? 44 : 0) };
  });
}
