/// <reference types="@vitest/browser-playwright" />
/**
 * The Gmail standing-permission lists' targets under each native pointer
 * (#4212).
 *
 * Every story's play measures every control's visible box and touch target
 * from real geometry, the `::after` that `.bk-hit` draws included, and probes
 * 1px inside each edge of the target. The Storybook projects run Chromium
 * with a fine pointer, where a reaching control gains no reach (#3252), so the
 * allowance list's Revoke shows its 44px touch target only here: rail-coarse
 * and rail-mixed launch Chromium with a native coarse pointer, and rail-fine
 * keeps the fine one. Each story runs as written, play included, after the
 * pointer premise is asserted.
 */
import { clearAllMocks } from "storybook/test";
import { beforeEach, expect, inject, test } from "vitest";

import * as allowances from "../../stories/google/GoogleAllowanceList.stories.js";
import * as approvals from "../../stories/google/GoogleApprovalList.stories.js";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

interface Runnable {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

const stories = (module: Record<string, unknown>) =>
  Object.entries(module).filter((entry): entry is [string, Runnable] => typeof (entry[1] as Runnable | undefined)?.run === "function");

beforeEach(() => {
  // A play asserts its own calls; Storybook clears the spies between stories,
  // and `run()` alone does not.
  clearAllMocks();
});

for (const [family, module] of [["approvals", approvals], ["allowances", allowances]] as const) {
  for (const [name, story] of stories(module)) {
    test(`google ${family}: ${name}`, async () => {
      const mode = inject("railPointer");
      expect(matchMedia("(any-pointer: coarse)").matches, "native coarse pointer premise").toBe(mode !== "fine");
      await story.run();
    });
  }
}
