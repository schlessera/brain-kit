import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { argos, eurycleia, issueBody, penelope, telemachus } from "../../fixtures/github.js";
import { GitHubComment } from "../../src/github/GitHubComment.js";
import { GitHubThread, type GitHubThreadItem } from "../../src/github/GitHubThread.js";
import { stage } from "../_stage.js";
import { desktop, narrow } from "./_github.js";

const URL_ = (anchor: string) => `https://github.com/ithaca/hall/pull/412#${anchor}`;

/** Every event kind, each with its own direct `GitHub ↗` (D3). */
const EVENTS: GitHubThreadItem[] = [
  { kind: "comment", id: "c", author: telemachus, time: "3 d ago", body: "Added the check. It runs before and after the axe line.", htmlUrl: URL_("issuecomment-1") },
  { kind: "comment", id: "clamped", author: eurycleia, time: "2 d ago", body: [issueBody, issueBody].join("\n\n"), htmlUrl: URL_("issuecomment-2") },
  { kind: "review", id: "approved", reviewer: penelope, state: "approved", time: "1 d ago", htmlUrl: URL_("pullrequestreview-1") },
  { kind: "review", id: "changes", reviewer: eurycleia, state: "changes-requested", time: "2 d ago", body: "Sinew stretches in the damp. Add a re-check after the first three shots.", lineComments: 2, onShowLineComments: () => {}, htmlUrl: URL_("pullrequestreview-2") },
  { kind: "review", id: "commented", reviewer: argos, state: "commented", time: "2 d ago", body: "The horn looks sound from here.", htmlUrl: URL_("pullrequestreview-3") },
  { kind: "review", id: "dismissed", reviewer: telemachus, state: "dismissed", time: "1 d ago", htmlUrl: URL_("pullrequestreview-4") },
  { kind: "merge", id: "merge", by: penelope, into: "main", sha: "a3f9c21", time: "1 d ago" },
];

const WITHOUT_LINKS = EVENTS.map((item) => (item.kind === "merge" ? item : { ...item, htmlUrl: undefined }));

/**
 * A thread: comments, reviews and the merge, newest last (#3800, design
 * #3795 §1). A review is its own event; an approval alone is one line.
 */
const meta = preview.meta({
  title: "GitHub/GitHubThread",
  component: GitHubThread,
  decorators: [stage],
  args: { items: EVENTS },
});

/** Each item with its direct link. */
export const WithLinks = meta.story({
  ...desktop,
  play: async ({ canvasElement }) => {
    const links = [...canvasElement.querySelectorAll("a")];
    await expect(links).toHaveLength(6);
    for (const link of links) {
      await expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      await expect(link.getAttribute("target")).toBe("_blank");
    }
  },
});
export const WithLinksNarrow = WithLinks.extend({ ...narrow });

/** The same items with no URL props: no links, and nothing else changes. */
export const WithoutLinks = meta.story({
  args: { items: WITHOUT_LINKS },
  ...desktop,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("a")).toHaveLength(0);
  },
});
export const WithoutLinksNarrow = WithoutLinks.extend({ ...narrow });

export const Empty = meta.story({ args: { items: [], label: "Comments · 0" }, ...desktop });
export const EmptyNarrow = Empty.extend({ ...narrow });

/** A comment alone, clamped at six lines with "Show whole comment". */
export const ClampedComment = meta.story({
  ...desktop,
  render: () => <GitHubComment author={eurycleia} time="5 h ago" body={[issueBody, issueBody, issueBody].join("\n\n")} htmlUrl={URL_("issuecomment-3")} />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Show whole comment" })).toBeVisible();
  },
});
export const ClampedCommentNarrow = ClampedComment.extend({ ...narrow });
