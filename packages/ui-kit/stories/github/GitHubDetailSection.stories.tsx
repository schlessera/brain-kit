import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn, waitFor } from "storybook/test";

import { commits } from "../../fixtures/github.js";
import { GitHubCommitRow } from "../../src/github/GitHubCommitRow.js";
import { GitHubDetailSection, type GitHubDetailSectionProps, type GitHubDetailState } from "../../src/github/GitHubDetailSection.js";
import { stage } from "../_stage.js";
import { desktop, narrow } from "./_github.js";

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const commit = commits[i % commits.length]!;
    return <GitHubCommitRow key={i} {...commit} sha={`${commit.sha.slice(0, 5)}${String(i).padStart(2, "0")}`} />;
  });

const BASE = { noun: "commits", object: "pull request", idleLabel: "Show commits · 4 of 112 in result" };

/**
 * A part of a GitHub object loaded only when the reader asks (#3800, design
 * #3795 §7), in each of its states S0 to S7. What loads here is for the
 * reader; Brain has not read it, and the section says so.
 */
const meta = preview.meta({
  title: "GitHub/GitHubDetailSection",
  component: GitHubDetailSection,
  decorators: [stage],
  args: { state: "idle", ...BASE, onLoad: fn(), onLoadMore: fn(), onRetry: fn() },
});

const state = (s: GitHubDetailState, extra: Partial<GitHubDetailSectionProps> = {}) => ({ args: { ...BASE, ...extra, state: s } satisfies GitHubDetailSectionProps });

/** S0: nothing loaded yet. */
export const Idle = meta.story({
  ...state("idle"),
  ...desktop,
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Show commits · 4 of 112 in result" }));
    await expect(args.onLoad).toHaveBeenCalled();
  },
});
export const IdleNarrow = Idle.extend({ ...narrow });

/** S1: ghost rows while the part loads. */
export const Loading = meta.story({ ...state("loading"), ...desktop });
export const LoadingNarrow = Loading.extend({ ...narrow });

/**
 * S1 under reduced motion: the ghost holds still. Storybook cannot set the
 * media feature, so `tests/visual/github.visual.tsx` renders this story with
 * `prefers-reduced-motion: reduce` emulated and asserts that nothing animates.
 */
export const LoadingReducedMotion = meta.story({ ...state("loading"), ...desktop });

/** S2: loaded, more to load. */
export const LoadedMore = meta.story({
  ...state("loaded", { moreLabel: "Load 30 more · 2 of 112 shown", children: rows(2) }),
  ...desktop,
});
export const LoadedMoreNarrow = LoadedMore.extend({ ...narrow });

/** S2, fully loaded: no Load more. */
export const LoadedAll = meta.story({ ...state("loaded", { children: rows(4) }), ...desktop });
export const LoadedAllNarrow = LoadedAll.extend({ ...narrow });

/** Load more moves focus to the first new row once it arrives. */
export const LoadMoreFocus = meta.story({
  ...state("loaded"),
  ...desktop,
  render: (args) => {
    const [count, setCount] = useState(2);
    return (
      <GitHubDetailSection {...args} state="loaded" moreLabel={count < 4 ? "Load 2 more · 2 of 4 shown" : undefined} onLoadMore={() => setCount(4)}>
        {rows(count)}
      </GitHubDetailSection>
    );
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Load 2 more · 2 of 4 shown" }));
    await waitFor(() => expect(document.activeElement?.textContent).toContain("Re-cut the upper nock"));
  },
});

/** S3: GitHub returned nothing. */
export const Empty = meta.story({ ...state("empty"), ...desktop });
export const EmptyNarrow = Empty.extend({ ...narrow });

/** S4: GitHub answered with an error; Try again. */
export const Failed = meta.story({
  ...state("error", { errorStatus: 502 }),
  ...desktop,
  play: async ({ canvas, userEvent, args }) => {
    await expect(canvas.getByRole("status")).toHaveTextContent("Couldn't load commits. GitHub answered 502.");
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.onRetry).toHaveBeenCalled();
  },
});
export const FailedNarrow = Failed.extend({ ...narrow });

/** S5: rate limited. Try again stays enabled; a press before the reset shows the same notice. */
export const RateLimited = meta.story({
  ...state("rate-limited", { resetAt: "14:32", resetIn: "12 min" }),
  ...desktop,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Try again after 14:32" })).toBeEnabled();
  },
});
export const RateLimitedNarrow = RateLimited.extend({ ...narrow });

/** S6: no GitHub access set up. */
export const NoCredential = meta.story({ ...state("no-credential"), ...desktop });
export const NoCredentialNarrow = NoCredential.extend({ ...narrow });

/** S7: GitHub no longer shows the object to this brain. */
export const Gone = meta.story({ ...state("gone"), ...desktop });
export const GoneNarrow = Gone.extend({ ...narrow });

/** S0 to S7 together, for one capture of every state. */
export const EveryState = meta.story({
  ...state("idle"),
  ...narrow,
  render: (args) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, width: "100%" }}>
      <GitHubDetailSection {...args} state="idle" />
      <GitHubDetailSection {...args} state="loading" />
      <GitHubDetailSection {...args} state="loaded" moreLabel="Load 30 more · 2 of 112 shown">
        {rows(2)}
      </GitHubDetailSection>
      <GitHubDetailSection {...args} state="empty" />
      <GitHubDetailSection {...args} state="error" errorStatus={502} />
      <GitHubDetailSection {...args} state="rate-limited" resetAt="14:32" resetIn="12 min" />
      <GitHubDetailSection {...args} state="no-credential" />
      <GitHubDetailSection {...args} state="gone" />
    </div>
  ),
});
