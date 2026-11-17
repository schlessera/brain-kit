import preview from "#.storybook/preview";
import { expect, waitFor } from "storybook/test";

import { REPO, SEARCH_URL, results } from "../../fixtures/github.js";
import { GitHubResultList } from "../../src/github/GitHubResultList.js";
import { stage } from "../_stage.js";
import { desktop, narrow } from "./_github.js";

/**
 * The issues and pull requests a search returned (#3800, design #3795 §1 and
 * §6): eight rows, then "Show n more" up to what the tool returned, and
 * GitHub's total stated honestly, with the search link when the host gives
 * one (D2).
 */
const meta = preview.meta({
  title: "GitHub/GitHubResultList",
  component: GitHubResultList,
  decorators: [stage],
  args: { repo: REPO, query: "bow is:open", total: 143, results, searchUrl: SEARCH_URL },
});

/** Mixed kinds and states, with the search link under the footnote. */
export const Mixed = meta.story({
  ...desktop,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("GitHub has 123 more. Ask Brain to narrow the search.")).toBeVisible();
    await expect(canvas.getByRole("link", { name: "This search on GitHub, opens in a new tab" })).toHaveAttribute("href", SEARCH_URL);
  },
});
export const MixedNarrow = Mixed.extend({ ...narrow });

/** The same footnote with no `searchUrl`: no link, and nothing else changes. */
export const WithoutSearchLink = meta.story({
  args: { searchUrl: undefined },
  ...desktop,
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("link", { name: /This search/ })).toBeNull();
  },
});
export const WithoutSearchLinkNarrow = WithoutSearchLink.extend({ ...narrow });

/** All twenty: Show more reveals the rest and moves focus to the first new row. */
export const ShowMore = meta.story({
  ...desktop,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Show 12 more · 8 of 20 shown" }));
    await waitFor(() => expect(document.activeElement?.textContent).toContain("Bow hall chore #1"));
    await expect(canvas.getAllByRole("listitem")).toHaveLength(20);
  },
});
export const ShowMoreNarrow = ShowMore.extend({ ...narrow });

/** A row open in place: the search summary, untrusted, and its GitHub link. */
export const RowExpanded = meta.story({
  ...desktop,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /Bow string frays/ }));
    await expect(canvas.getByRole("button", { name: /outside link to ithaca\.example/ })).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Issue #409 on GitHub, opens in a new tab" })).toBeVisible();
  },
});
export const RowExpandedNarrow = RowExpanded.extend({ ...narrow });

export const Empty = meta.story({ args: { results: [], total: 0, query: "crossbow is:open" }, ...desktop });
export const EmptyNarrow = Empty.extend({ ...narrow });

/** GitHub flagged the search as possibly incomplete. */
export const Incomplete = meta.story({ args: { incomplete: true, results: results.slice(0, 5), total: 5 }, ...desktop });
export const IncompleteNarrow = Incomplete.extend({ ...narrow });
