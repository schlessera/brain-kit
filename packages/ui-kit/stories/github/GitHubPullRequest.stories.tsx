import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, within } from "storybook/test";

import { argos, commits, eurycleia, penelope, pr, prThread, telemachus } from "../../fixtures/github.js";
import { GitHubCommitRow } from "../../src/github/GitHubCommitRow.js";
import { GitHubDetailSection } from "../../src/github/GitHubDetailSection.js";
import { GitHubPullRequest, type GitHubPullRequestProps } from "../../src/github/GitHubPullRequest.js";
import { GitHubThread } from "../../src/github/GitHubThread.js";
import { stage } from "../_stage.js";
import { avatarsLoaded, desktop, narrow, withAvatar } from "./_github.js";

const TABS = [
  { label: "Conversation", count: 12 },
  { label: "Commits", count: 4 },
  { label: "Files", count: 6 },
  { label: "Checks", count: 8 },
];

/** The tab contents a host would render: the returned thread, then on-demand sections. */
function TabContent({ tab }: { tab: number }) {
  if (tab === 0)
    return (
      <GitHubThread
        items={prThread}
        before={<GitHubDetailSection state="idle" noun="comments" object="pull request" idleLabel="Load 9 earlier comments" />}
      />
    );
  if (tab === 1)
    return (
      <GitHubDetailSection state="loaded" noun="commits" object="pull request" idleLabel="Show commits" moreLabel="Load 30 more · 2 of 112 shown">
        {commits.slice(0, 2).map((commit) => (
          <GitHubCommitRow key={commit.sha} {...commit} />
        ))}
      </GitHubDetailSection>
    );
  if (tab === 2) return <GitHubDetailSection state="idle" noun="files" object="pull request" idleLabel="Show files · 6 changed" />;
  return <GitHubDetailSection state="loading" noun="checks" object="pull request" idleLabel="Show checks" />;
}

type StoryArgs = Omit<GitHubPullRequestProps, "tabs" | "children"> & { tab?: number };

function Stateful({ tab: initial = 0, ...props }: StoryArgs) {
  const [tab, setTab] = useState(initial);
  return (
    <GitHubPullRequest {...props} tabs={{ items: TABS, active: tab, onSelect: setTab }}>
      <TabContent tab={tab} />
    </GitHubPullRequest>
  );
}

/**
 * A pull request as the tool returned it (#3800, design #3795 §1). Above the
 * tabs is everything the result carries; the tabs load the rest on demand,
 * and "Brain read" never grows when they do.
 */
const meta = preview.meta({
  title: "GitHub/GitHubPullRequest",
  // The stateful wrapper owns the selected tab, so `tab` is a story arg.
  component: Stateful,
  decorators: [stage],
  args: { ...pr, author: withAvatar(telemachus, "telemachus") } as StoryArgs,
});

/** Open, one change request, one check failing. */
export const ChangesRequested = meta.story({
  ...desktop,
  play: async ({ canvasElement }) => {
    await avatarsLoaded(canvasElement);
  },
});
export const ChangesRequestedNarrow = ChangesRequested.extend({ ...narrow });

/** Approved and passing. */
export const ApprovedPassing = meta.story({
  args: { reviews: { changesRequested: 0, approved: 2 }, checks: { passed: 8, failed: 0, running: 0 }, reviewers: [{ person: penelope, state: "approved", time: "1 d ago" }, { person: eurycleia, state: "approved", time: "1 d ago" }] },
  ...desktop,
});
export const ApprovedPassingNarrow = ApprovedPassing.extend({ ...narrow });

/** Checks still running. */
export const ChecksRunning = meta.story({ args: { checks: { passed: 5, failed: 0, running: 2 } }, ...desktop });
export const ChecksRunningNarrow = ChecksRunning.extend({ ...narrow });

/** No checks reported: "— None reported", never teal, never ✓. */
export const ChecksAbsent = meta.story({
  args: { checks: null },
  ...desktop,
  play: async ({ canvasElement }) => {
    const checks = canvasElement.querySelector("[data-github-fact='checks']")!;
    await expect(checks.textContent).toBe("Checks—None reported");
  },
});
export const ChecksAbsentNarrow = ChecksAbsent.extend({ ...narrow });

/** Review state not reported: the fact and the reviewer row read "— Not reported". */
export const ReviewUnknown = meta.story({
  args: { reviews: null, reviewers: [{ person: argos, state: null }] },
  ...desktop,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-github-fact='reviews']")!.textContent).toBe("Reviews—Not reported");
    const reviewers = canvasElement.querySelector("[role='group'][aria-label='Reviewers']")!;
    await expect(reviewers.textContent).toContain("—Not reported");
    await expect(reviewers.querySelectorAll("[data-github-state='approved'], svg")).toHaveLength(0);
  },
});
export const ReviewUnknownNarrow = ReviewUnknown.extend({ ...narrow });

export const Draft = meta.story({ args: { state: "draft", title: "Draft: bow-draw weight table", checks: null, reviews: { changesRequested: 0, approved: 0 }, reviewers: [] }, ...desktop });
export const DraftNarrow = Draft.extend({ ...narrow });

/** Merged: the banner under the header, and no checks reported. */
export const Merged = meta.story({
  args: {
    state: "merged",
    checks: null,
    reviews: { changesRequested: 0, approved: 2 },
    reviewers: [{ person: penelope, state: "approved", time: "1 d ago" }, { person: eurycleia, state: "approved", time: "1 d ago" }],
    merge: { by: penelope, into: "main", sha: "a3f9c21", time: "1 d ago" },
    brainRead: "description, 2 reviews, 1 comment, 4 commits.",
  },
  ...desktop,
});
export const MergedNarrow = Merged.extend({ ...narrow });

export const ClosedNotMerged = meta.story({ args: { state: "closed", checks: { passed: 3, failed: 2, running: 0 } }, ...desktop });
export const ClosedNotMergedNarrow = ClosedNotMerged.extend({ ...narrow });

/** A long title and branch at 320: both wrap anywhere, nothing overflows. */
export const LongTitleNarrow = meta.story({
  args: {
    title: "Restring the great bow before the contest, re-cut the worn upper nock, wax the new sinew twice and align all twelve axe heads in the hall floor",
    headRef: "telemachus/restring-the-great-bow-and-recut-the-upper-nock-before-the-contest",
  },
  ...narrow,
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector("[data-github-pr]")!;
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  },
});

/** Each tab selected: Commits (loaded, more to load), Files (idle) and Checks (loading). */
export const CommitsTab = meta.story({
  args: { tab: 1 },
  ...desktop,
  play: async ({ canvas, userEvent }) => {
    const tabs = canvas.getAllByRole("tab");
    await expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.click(tabs[2]!);
    await expect(canvas.getByRole("tab", { name: /Files/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(tabs[1]!);
  },
});
export const CommitsTabNarrow = CommitsTab.extend({ ...narrow });
export const FilesTab = meta.story({ args: { tab: 2 }, ...desktop });
export const FilesTabNarrow = FilesTab.extend({ ...narrow });
export const ChecksTab = meta.story({ args: { tab: 3 }, ...desktop });
export const ChecksTabNarrow = ChecksTab.extend({ ...narrow });

/** Not posted yet: the preview chip, and no canonical link. */
export const Preview = meta.story({
  args: { preview: true },
  ...desktop,
  play: async ({ canvasElement }) => {
    const header = within(canvasElement.querySelector("[data-github-pr]") as HTMLElement);
    await expect(header.getByText("Not posted")).toBeVisible();
    await expect(canvasElement.querySelector("[data-github-ref] + a")).toBeNull();
  },
});
export const PreviewNarrow = Preview.extend({ ...narrow });
