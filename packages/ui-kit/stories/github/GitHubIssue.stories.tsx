import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { antinous, eurycleia, issue, issueThread, philoetius, telemachus } from "../../fixtures/github.js";
import { GitHubDetailSection } from "../../src/github/GitHubDetailSection.js";
import { GitHubIssue, type GitHubIssueProps } from "../../src/github/GitHubIssue.js";
import { GitHubThread } from "../../src/github/GitHubThread.js";
import { stage } from "../_stage.js";
import { desktop, narrow, withAvatar } from "./_github.js";

const thread = (
  <GitHubThread
    label="Comments · 17"
    items={issueThread}
    before={<GitHubDetailSection state="idle" noun="comments" object="issue" idleLabel="Load 14 earlier comments" />}
  />
);

/**
 * An issue as the tool returned it, then its thread (#3800, design #3795
 * §1). The same header as a pull request, without facts or branches.
 */
const meta = preview.meta({
  title: "GitHub/GitHubIssue",
  component: GitHubIssue,
  decorators: [stage],
  args: {
    ...issue,
    participants: { people: [withAvatar(eurycleia, "penelope"), withAvatar(philoetius, "philoetius"), antinous, withAvatar(telemachus, "telemachus")], count: 4 },
    children: thread,
  } as GitHubIssueProps,
});

export const Open = meta.story({ ...desktop });
export const OpenNarrow = meta.story({ ...narrow });

export const Completed = meta.story({ args: { state: "completed" }, ...desktop });
export const CompletedNarrow = Completed.extend({ ...narrow });

export const NotPlanned = meta.story({ args: { state: "not-planned" }, ...desktop });
export const NotPlannedNarrow = NotPlanned.extend({ ...narrow });

export const Locked = meta.story({
  args: { locked: true },
  ...desktop,
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/Locked/)).toBeVisible();
  },
});
export const LockedNarrow = Locked.extend({ ...narrow });

export const NoBody = meta.story({ args: { body: null }, ...desktop });
export const NoBodyNarrow = NoBody.extend({ ...narrow });

/** The payload cut the body; the rest is on GitHub, through the canonical link. */
export const TruncatedBody = meta.story({ args: { bodyTruncated: true }, ...desktop });
export const TruncatedBodyNarrow = TruncatedBody.extend({ ...narrow });

/** W1's object: not posted yet. As shown renders the subset; Exact text is the raw string that will be sent. */
export const Preview = meta.story({
  args: {
    repo: "ithaca/hall",
    number: null,
    title: "Cellar key log is not signed after dusk",
    labels: ["stores"],
    body: "Since the new moon the key log has no entries after dusk. Proposed: **two** signatures per opening.",
    participants: undefined,
    author: undefined,
    children: undefined,
    brainRead: undefined,
    posting: { status: "preview" },
  },
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(canvasElement.querySelector("a")).toBeNull();
    await userEvent.click(canvas.getByRole("tab", { name: "Exact text" }));
    await expect(canvasElement.querySelector("[data-github-exact]")!.textContent).toContain("**two**");
    await userEvent.click(canvas.getByRole("tab", { name: "As shown" }));
  },
});
export const PreviewNarrow = Preview.extend({ ...narrow });

/** W2's object: the real issue GitHub returned, posted by you via Brain. */
export const Posted = meta.story({
  args: {
    number: 401,
    htmlUrl: "https://github.com/ithaca/hall/issues/401",
    title: "Cellar key log is not signed after dusk",
    labels: [],
    participants: undefined,
    author: undefined,
    children: undefined,
    brainRead: undefined,
    posting: { status: "posted", time: "just now", note: "Approved in this chat at 14:02 · recorded as an outward action" },
  },
  ...desktop,
});
export const PostedNarrow = Posted.extend({ ...narrow });
