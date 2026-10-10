/** Preserve the numeric layer fence while colour generators rewrite declarations. */
export function splitLayersBlock(css: string): { outside: string; restore: (outside: string) => string } {
  const start = "/* @layers:start */";
  const end = "/* @layers:end */";
  if (!css.includes(start) && !css.includes(end)) return { outside: css, restore: outside => outside };
  if (css.split(start).length !== 2 || css.split(end).length !== 2 || css.indexOf(end) < css.indexOf(start)) {
    throw new Error("tokens.css must have one ordered @layers fence");
  }
  const block = css.slice(css.indexOf(start), css.indexOf(end) + end.length);
  const marker = "\u0000layers\u0000";
  return { outside: css.replace(block, marker), restore: outside => outside.replace(marker, () => block) };
}
