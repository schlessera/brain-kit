/**
 * Model IDs this module used to route to and no longer supports.
 *
 * gpt-image-2 and gpt-image-1.5 were retired on 2026-09-29 (#586): the
 * GPT Image 2.5 models return real alpha transparency, which was the only
 * reason gpt-image-1.5 stayed, and Sunburst replaces gpt-image-2 as the
 * default (itself succeeded by 2.6 Sunburst, #3782). Nothing falls back to a retired model — not for transparency, not
 * on an error, not for availability or quality. Naming one explicitly gets a
 * migration error instead of a silent substitute.
 */
export const RETIRED_MODELS: Readonly<Record<string, string>> = {
  "gpt-image-2": "gpt-image-2.6-sunburst",
  "gpt-image-1.5": "gpt-image-2.6-sunburst",
};

export function isRetiredModel(id: string): boolean {
  return Object.hasOwn(RETIRED_MODELS, id);
}

/**
 * The migration message for a retired model named in `where` (a flag or a
 * config key). Names both replacements, because the right one depends on
 * what the old choice was for.
 */
export function retiredModelMessage(id: string, where: string): string {
  return (
    `Model "${id}" (${where}) is retired and no longer supported. Use ` +
    `"gpt-image-2.6-sunburst" (the default: most capable, transparency on png/webp) or ` +
    `"gpt-image-2.6-flare" (faster). Both take transparent backgrounds, masks, custom ` +
    `sizes, xhigh/max quality and complexity.`
  );
}
