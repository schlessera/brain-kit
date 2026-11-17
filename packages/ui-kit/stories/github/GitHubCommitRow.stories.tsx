import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { commits, penelope } from "../../fixtures/github.js";
import { GitHubCommitRow } from "../../src/github/GitHubCommitRow.js";
import { GitHubMergeEvent } from "../../src/github/GitHubMergeEvent.js";
import { stage } from "../_stage.js";
import { desktop, narrow } from "./_github.js";

/**
 * A commit row and the merge event (#3800, design #3795 §1). A row expands
 * its full message in place; its direct `GitHub ↗` (D3) sits beside it. The
 * payload has no merge method, so there is no squash story.
 */
const meta = preview.meta({
  title: "GitHub/GitHubCommitRow",
  component: GitHubCommitRow,
  decorators: [stage],
  args: commits[0]!,
});

export const Normal = meta.story({
  ...desktop,
  play: async ({ canvas, userEvent }) => {
    const row = canvas.getByRole("button", { name: /Add tension check/ });
    await userEvent.click(row);
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(/reads the draw weight/)).toBeVisible();
  },
});
export const NormalNarrow = Normal.extend({ ...narrow });

/** A subject past 120 characters, cut, with no GitHub account for its author. */
export const LongSubjectUnknownAuthor = meta.story({ args: { ...commits[2]!, message: null, htmlUrl: null }, ...desktop });
export const LongSubjectUnknownAuthorNarrow = LongSubjectUnknownAuthor.extend({ ...narrow });

/** No direct link: the slot renders nothing, and nothing else changes. */
export const WithoutLink = meta.story({
  args: { ...commits[1]!, message: null, htmlUrl: undefined },
  ...desktop,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("a, button")).toHaveLength(0);
  },
});
export const WithoutLinkNarrow = WithoutLink.extend({ ...narrow });

/** The merge, as the banner under a PR's header and as the Conversation tab's last event. */
export const MergeBanner = meta.story({
  ...desktop,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      <GitHubMergeEvent by={penelope} into="main" sha="a3f9c21" time="1 d ago" />
      <GitHubMergeEvent by={penelope} into="main" sha="a3f9c21" time="1 d ago" variant="event" />
    </div>
  ),
});
export const MergeBannerNarrow = MergeBanner.extend({ ...narrow });
