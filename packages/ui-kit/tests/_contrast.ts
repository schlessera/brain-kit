/**
 * WCAG 2.x contrast, the way axe measures it, shared by the kit's contrast
 * tests (`contrast.test.ts` for the inks and tints, `canvas-palette.test.ts`
 * for the two canvas sets). One copy, so every test rounds the same way.
 */

export type Rgb = [number, number, number];

export function parse(value: string): { rgb: Rgb; alpha: number } {
  if (value.startsWith("#")) {
    const hex = value.length === 4 ? [...value.slice(1)].map((c) => c + c).join("") : value.slice(1);
    return { rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb, alpha: 1 };
  }
  const parts = value.match(/rgba?\(([^)]+)\)/)?.[1].split(",").map(Number);
  if (!parts) throw new Error(`not a colour: ${value}`);
  return { rgb: [parts[0]!, parts[1]!, parts[2]!], alpha: parts[3] ?? 1 };
}

/** Source-over compositing, which is what a browser does with a translucent
 * background and what `opacity` does to a whole subtree. Channels are rounded
 * because a rendered pixel is an integer, and the rounding is what makes these
 * numbers reproduce the hex values axe reported (`#64626b` on `#121417`) rather
 * than land a fraction off them. */
export function over(top: { rgb: Rgb; alpha: number }, bottom: Rgb): Rgb {
  return bottom.map((b, i) => Math.round(top.alpha * top.rgb[i]! + (1 - top.alpha) * b)) as Rgb;
}

export function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG 2.x contrast, rounded to two places the way axe reports it. */
export function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
