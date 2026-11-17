import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

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
