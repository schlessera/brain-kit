import addonA11y from "@storybook/addon-a11y";
import addonThemes, { withThemeByDataAttribute } from "@storybook/addon-themes";
import { definePreview } from "@storybook/react-vite";

// The Tailwind entry, and the same one `scripts/build.ts` compiles into the
// published `dist/styles.css` — so the Storybook and the shipped stylesheet
// cannot drift apart.
import "../src/styles.css";

export default definePreview({
  addons: [addonA11y(), addonThemes()],
  decorators: [
    // The toolbar's theme switch, and the `theme` global the Vitest matrix pins
    // (D9, real since the 2026-09-18 drop shipped the paper palette). It sets
    // `data-theme` on <html>; `theme.css` maps that onto `color-scheme`, which
    // is what every `light-dark()` token reads. Dark by default so the visual
    // baselines and every existing story keep their ground; a story that wants
    // paper sets `globals: { theme: "light" }`, and the light Vitest project
    // runs every story that way — with the a11y gate still at `'error'`, which
    // is the contrast proof the light theme did not have before.
    //
    // `print` is the third value: the palette a shared PNG or PDF is drawn in
    // (#46). No project runs every story in it; `Blocks/In print` pins it.
    withThemeByDataAttribute({
      themes: { dark: "dark", light: "light", print: "print" },
      defaultTheme: "dark",
      attributeName: "data-theme",
    }),
  ],
  parameters: {
    // THE GATE. D17 is closed here.
    //
    // `'error'` fails the Vitest run on any axe violation in any story. The
    // predecessor value, `'todo'`, is SILENT IN CI — violations show as
    // warnings in the Storybook UI and fail nothing, anywhere — which is why
    // D17 required that the commit flipping this show CI failing on a seeded
    // violation FIRST. It does: a bare `<img>` with no alt added to `Callout`
    // passed 503/503 at `'todo'` and failed six stories with
    // "Images must have alternative text (image-alt)" at `'error'`. The
    // The measurement is recorded in `docs/decisions/design-kit.md`.
    //
    // A story may disable ONE RULE for a reason it states, through
    // `knownContrastGap()` in `stories/_stage.tsx`. Four contrast findings use
    // it; all four are design decisions recorded in
    // `docs/decisions/design-feedback.md`, with their measured ratios asserted in
    // `tests/contrast.test.ts` so that the day a token moves, a test says so.
    // Nothing else may switch a rule off.
    // THE GATE, in BOTH themes. `'error'` fails the Vitest run on any axe
    // violation in any story, and the light project runs the same rule set on
    // paper. (For one day the light project ran without `color-contrast`: the
    // first light palette was stated against the surface and failed on the
    // canvas — design-feedback §19. The revised palette fixed it and the
    // exception is gone; do not reintroduce a theme-specific rule set.)
    a11y: { test: "error" },
    layout: "centered",
  },
  tags: ["autodocs"],
});
