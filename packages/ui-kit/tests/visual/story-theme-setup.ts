import { afterEach, beforeEach, inject } from "vitest";

declare module "vitest" {
  interface ProvidedContext { storyTheme: string }
}

// Keep runner-only imports out of portable stories and Storybook dev. The
// preview's afterEach compares this independent input to the resolved global,
// decorator attribute and Chromium's native color-scheme for every story.
beforeEach(() => {
  document.documentElement.dataset.expectedStoryTheme = inject("storyTheme");
});
afterEach(() => { delete document.documentElement.dataset.expectedStoryTheme; });
