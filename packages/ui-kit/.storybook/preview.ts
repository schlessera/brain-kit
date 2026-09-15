import addonA11y from "@storybook/addon-a11y";
import addonThemes from "@storybook/addon-themes";
import { definePreview } from "@storybook/react-vite";

// The Tailwind entry, and the same one `scripts/build.ts` compiles into the
// published `dist/styles.css` — so the Storybook and the shipped stylesheet
// cannot drift apart.
import "../src/styles.css";

export default definePreview({
  addons: [
    addonA11y(),
    // Registered, but with no decorator yet. The kit is dark-only: the design's
    // Foundations lists twelve dark tokens and no second table, and the one
    // light surface in the whole source is `PhoneFrame theme="paper"`. Whether
    // that becomes a real second theme is an open question in `.plan/PLAN.md`;
    // if it does, this is where `withThemeByDataAttribute` goes and D9's
    // two-project Vitest matrix becomes real.
    addonThemes(),
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
    // measurement is in `.plan/PLAN.md`'s wave 1b notes.
    //
    // A story may disable ONE RULE for a reason it states, through
    // `knownContrastGap()` in `stories/_stage.tsx`. Four contrast findings use
    // it; all four are design decisions recorded in
    // `.plan/design-feedback.md`, with their measured ratios asserted in
    // `tests/contrast.test.ts` so that the day a token moves, a test says so.
    // Nothing else may switch a rule off.
    a11y: { test: "error" },
    layout: "centered",
  },
  tags: ["autodocs"],
});
