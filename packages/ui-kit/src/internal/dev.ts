/**
 * Re-creates the one dev signal the DC runtime had and React does not.
 *
 * `walkText` logged `"{{ x }} never resolved — rendered as empty"` once per
 * component and hole, and `sc-for` logged a list that was not an array. React
 * renders nothing and says nothing, so a component that is silently short a
 * row, or an icon key with a typo in it, looks merely empty.
 * (`.plan/design/runtime-to-react.md` §8.5.)
 *
 * Warn-once, keyed on the message: `renderVals()` runs on every render, so an
 * unguarded warn inside one would repeat for the life of the page.
 *
 * Unconditional, not gated on an environment flag. `process.env` is refused
 * inside a package outside its `src/config/env.ts` chokepoint and
 * `import.meta.env` is refused everywhere (`scripts/check-env-access.ts`), and
 * this is a developer error either way — the DC runtime warned unconditionally
 * too.
 */

const seen = new Set<string>();

export function warnOnce(message: string): void {
  if (seen.has(message)) return;
  seen.add(message);
  console.warn(`[brain-ui-kit] ${message}`);
}
