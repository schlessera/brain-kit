import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { GitHubStateChip } from "../../src/github/GitHubStateChip.js";
import type { GitHubState } from "../../src/github/shared.js";
import { Row, stage } from "../_stage.js";
import { desktop, narrow } from "./_github.js";

/**
 * Every GitHub state as a glyph and a word (#3800, design #3795 §5). Colour
 * only reinforces. Absent is never passing: "None reported" and "Not
 * reported" are a neutral dash, never teal and never ✓.
 */
const meta = preview.meta({
  title: "GitHub/GitHubStateChip",
  component: GitHubStateChip,
  decorators: [stage],
  args: { state: "open" },
});

const ALL: { state: GitHubState; kind?: "pr" | "issue"; count?: number; caption: string }[] = [
  { state: "open", kind: "pr", caption: "open (PR)" },
  { state: "open", kind: "issue", caption: "open (issue)" },
  { state: "draft", caption: "draft" },
  { state: "merged", caption: "merged" },
  { state: "closed", caption: "closed (PR)" },
  { state: "completed", caption: "completed" },
  { state: "not-planned", caption: "not planned" },
  { state: "approved", caption: "approved" },
  { state: "changes-requested", caption: "changes req." },
  { state: "review-requested", caption: "requested" },
  { state: "commented", caption: "commented" },
  { state: "dismissed", caption: "dismissed" },
  { state: "failing", count: 1, caption: "failing" },
  { state: "running", count: 2, caption: "running" },
  { state: "passed", count: 7, caption: "passed" },
  { state: "none-reported", caption: "checks absent" },
  { state: "not-reported", caption: "unknown" },
  { state: "not-posted", caption: "not posted" },
  { state: "posted", caption: "posted" },
];

/** Every state, as a chip and inline. */
export const EveryState = meta.story({
  ...desktop,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
      {ALL.map(({ caption, ...p }) => (
        <Row key={caption} caption={caption}>
          <GitHubStateChip {...p} />
          <GitHubStateChip {...p} variant="inline" />
        </Row>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const absent of canvasElement.querySelectorAll("[data-github-state='none-reported'], [data-github-state='not-reported']")) {
      await expect(absent.querySelector("svg")).toBeNull();
      await expect(absent.textContent).not.toMatch(/passed|✓/);
    }
  },
});
export const EveryStateNarrow = EveryState.extend({ ...narrow });
