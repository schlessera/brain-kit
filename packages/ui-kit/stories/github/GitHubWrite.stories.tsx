import preview from "#.storybook/preview";
import { expect, fn, userEvent } from "storybook/test";

import { brainBot } from "../../fixtures/github.js";
import { ApprovalCard } from "../../src/decisions/ApprovalCard.js";
import { GitHubComment } from "../../src/github/GitHubComment.js";
import { GitHubIssue, GitHubWriteNotice } from "../../src/github/GitHubIssue.js";
import { GitHubRef } from "../../src/github/GitHubRef.js";
import { color, font } from "../../src/tokens.js";
import { stage } from "../_stage.js";
import { desktop, narrow } from "./_github.js";

/**
 * The write tools reuse the same components (#3800, design #3795 § "Write
 * tools"): W1 an issue approval, W2 the posted result, W3 a write that did
 * not happen, W4 a comment approval. The approval shell is `ApprovalCard`,
 * unchanged; its body hosts the GitHub component in preview.
 */
const meta = preview.meta({
  title: "GitHub/Write",
  component: ApprovalCard,
  decorators: [stage],
});

const lead = { margin: 0, font: `400 12px/1.5 ${font.body}`, color: color.inkDim } as const;

/** W1: brain_github_issue_create, waiting for approval. */
export const W1IssueApproval = meta.story({
  ...desktop,
  render: () => (
    <ApprovalCard tool="Post to GitHub?" target="ithaca/hall" toolIcon="issue-open" badge="Can't be undone" diff="" risk="" wrapHeader allowLabel="Post issue" denyLabel="Don't post" onAllow={fn()} onDeny={fn()}>
      <p style={lead}>
        Creates a public issue in <strong>ithaca/hall</strong> as <strong>@ithaca-brain</strong>.
      </p>
      <GitHubIssue
        state="open"
        repo="ithaca/hall"
        title="Cellar key log is not signed after dusk"
        labels={["stores"]}
        body="Since the new moon the key log has no entries after dusk. Proposed: two signatures per opening."
        posting={{ status: "preview" }}
      />
    </ApprovalCard>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Not posted")).toBeVisible();
    await expect(canvas.queryByRole("link")).toBeNull();
  },
});
export const W1IssueApprovalNarrow = W1IssueApproval.extend({ ...narrow });

/**
 * W1 with a draft past the read bodies' 20,000-character bound (#4197): the
 * card shows all of what is approved, in both panes, and never says
 * "Truncated". The host posts up to 65,536 characters.
 */
const LONG_ISSUE_DRAFT = `${"The tally of the wine store, night by night. ".repeat(560)}The last line of the draft.`;
export const W1LongDraft = meta.story({
  ...desktop,
  render: () => (
    <ApprovalCard tool="Post to GitHub?" target="ithaca/hall" toolIcon="issue-open" badge="Can't be undone" diff="" risk="" wrapHeader allowLabel="Post issue" denyLabel="Don't post" onAllow={fn()} onDeny={fn()}>
      <GitHubIssue state="open" repo="ithaca/hall" title="The wine store tally, night by night" body={LONG_ISSUE_DRAFT} posting={{ status: "preview" }} />
    </ApprovalCard>
  ),
  play: async ({ canvas }) => {
    await expect(Array.from(LONG_ISSUE_DRAFT).length).toBeGreaterThan(20_000);
    await expect(canvas.queryByText(/Truncated/), "a draft is never shown cut").toBeNull();
    await expect(canvas.getByText(/The last line of the draft\./), "As shown renders the whole draft").toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Exact text" }));
    await expect(canvas.getByText(/The last line of the draft\.$/), "Exact text is the whole string").toBeVisible();
  },
});
export const W1LongDraftNarrow = W1LongDraft.extend({ ...narrow });

/** W2: the same slot, now the real object, posted. */
export const W2Posted = meta.story({
  ...desktop,
  render: () => (
    <GitHubIssue
      state="open"
      repo="ithaca/hall"
      number={401}
      htmlUrl="https://github.com/ithaca/hall/issues/401"
      title="Cellar key log is not signed after dusk"
      posting={{ status: "posted", time: "just now", note: "Approved in this chat at 14:02 · recorded as an outward action" }}
    />
  ),
});
export const W2PostedNarrow = W2Posted.extend({ ...narrow });

/** W3: not posted, in its three variants. */
export const W3NotPosted = meta.story({
  ...desktop,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
      <GitHubWriteNotice outcome="declined" />
      <GitHubWriteNotice outcome="changed" />
      <GitHubWriteNotice outcome="unknown" />
    </div>
  ),
});
export const W3NotPostedNarrow = W3NotPosted.extend({ ...narrow });

/** W4: brain_github_issue_comment: the target row above the comment in preview. */
export const W4CommentApproval = meta.story({
  ...desktop,
  render: () => (
    <ApprovalCard tool="Post a comment?" target="ithaca/hall #388" toolIcon="chat" badge="Can't be undone" diff="" risk="" wrapHeader allowLabel="Post comment" denyLabel="Don't post" onAllow={fn()} onDeny={fn()}>
      <GitHubRef kind="issue" repo="ithaca/hall" number={388} state="open" title="Suitors keep draining the wine store" htmlUrl="https://github.com/ithaca/hall/issues/388" />
      <GitHubComment author={brainBot} body="Filed #401 for the key log. The tally gap starts on the night of the new moon." preview />
    </ApprovalCard>
  ),
});
export const W4CommentApprovalNarrow = W4CommentApproval.extend({ ...narrow });

/**
 * W4 with what the host could not verify (#4154): the poster, the target's
 * kind, or both. An unknown poster is "The host's GitHub account", never
 * `@ghost`; an unknown kind is `repository #number`, never Issue or PR, and
 * has no link. Each fact is independent of the other.
 */
function W4Neutral(p: { poster: boolean; kind: "issue" | "pr" | null }) {
  const body = "Filed #401 for the key log. The tally gap starts on the night of the new moon.";
  return (
    <ApprovalCard tool="Post a comment?" target="ithaca/hall #388" toolIcon="chat" badge="Can't be undone" diff="" risk="" wrapHeader allowLabel="Post comment" denyLabel="Don't post" onAllow={fn()} onDeny={fn()}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px", minWidth: 0 }}>
        <GitHubRef kind={p.kind} repo="ithaca/hall" number={388} htmlUrl={p.kind ? `https://github.com/ithaca/hall/${p.kind === "pr" ? "pull" : "issues"}/388` : null} />
      </div>
      {p.poster ? <GitHubComment author={brainBot} body={body} preview /> : <GitHubComment body={body} preview />}
    </ApprovalCard>
  );
}

const neutralPlay = (expected: { poster: boolean; kind: "issue" | "pr" | null }) =>
  async ({ canvas, canvasElement }: { canvas: { getByText: (t: string | RegExp) => HTMLElement; queryByText: (t: string | RegExp) => HTMLElement | null; getByRole: (role: string, o?: object) => HTMLElement }; canvasElement: HTMLElement }) => {
    await expect(canvas.getByText("Not posted")).toBeVisible();
    await expect(canvas.getByText("Brain's draft · not posted"), "the draft says Brain wrote it, whoever would post it").toBeVisible();
    await expect(canvasElement.textContent, "an unverified poster is never the deleted-account ghost").not.toContain("@ghost");
    const comment = canvas.getByRole("article");
    if (expected.poster) {
      await expect(comment).toHaveAccessibleName("Comment not posted by @ithaca-brain");
    } else {
      await expect(canvas.getByText("The host's GitHub account")).toBeVisible();
      await expect(comment).toHaveAccessibleName("Comment not posted by the host's GitHub account");
      await expect(comment.querySelector("img"), "the host account loads no avatar").toBeNull();
    }
    const ref = canvasElement.querySelector("[data-github-ref]")!;
    if (expected.kind) {
      await expect(ref.textContent).toBe(`${expected.kind === "pr" ? "PR" : "Issue"} · ithaca/hall #388`);
      await expect(canvas.getByRole("link", { name: `${expected.kind === "pr" ? "PR" : "Issue"} · ithaca/hall #388 on GitHub, opens in a new tab` })).toBeVisible();
    } else {
      await expect(ref.textContent, "an unverified kind claims neither").toBe("ithaca/hall #388");
      await expect(canvasElement.querySelector("a"), "an unverified kind has no link").toBeNull();
    }
  };

/** W4, the poster unknown, on an issue. */
export const W4UnknownPoster = meta.story({ ...desktop, render: () => <W4Neutral poster={false} kind="issue" />, play: neutralPlay({ poster: false, kind: "issue" }) });
export const W4UnknownPosterNarrow = W4UnknownPoster.extend({ ...narrow });

/** W4, the target's kind unknown, the poster known. */
export const W4UnknownTarget = meta.story({ ...desktop, render: () => <W4Neutral poster kind={null} />, play: neutralPlay({ poster: true, kind: null }) });
export const W4UnknownTargetNarrow = W4UnknownTarget.extend({ ...narrow });

/** W4, nothing verified: both neutral states together. */
export const W4NothingVerified = meta.story({ ...desktop, render: () => <W4Neutral poster={false} kind={null} />, play: neutralPlay({ poster: false, kind: null }) });
export const W4NothingVerifiedNarrow = W4NothingVerified.extend({ ...narrow });

/** W4 on a pull request, both verified. */
export const W4PullRequest = meta.story({ ...desktop, render: () => <W4Neutral poster kind="pr" />, play: neutralPlay({ poster: true, kind: "pr" }) });
export const W4PullRequestNarrow = W4PullRequest.extend({ ...narrow });

/** W4 with the poster unknown on a pull request. */
export const W4UnknownPosterPullRequest = meta.story({ ...desktop, render: () => <W4Neutral poster={false} kind="pr" />, play: neutralPlay({ poster: false, kind: "pr" }) });
export const W4UnknownPosterPullRequestNarrow = W4UnknownPosterPullRequest.extend({ ...narrow });

/** A preview shows its whole draft: the posted comments' 10,000-character bound does not cut what is approved (#4154). */
export const W4LongDraft = meta.story({
  ...narrow,
  render: () => <GitHubComment body={`${"The tally of the wine store, night by night. ".repeat(240)}The last line of the draft.`} preview />,
  play: async ({ canvas }) => {
    await expect(canvas.queryByText("Truncated"), "a draft is never shown cut").toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Show whole comment" }));
    await expect(canvas.getByText(/The last line of the draft\./)).toBeVisible();
  },
});
