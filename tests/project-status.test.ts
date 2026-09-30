// What the project board derives, and what it must never touch.
//
// The `Ready` view is the one an agent filters on to pick up work unattended,
// so a Ready issue that is actually blocked is worse than no view at all — the
// agent takes it, finds its prerequisite missing, and either stalls or invents
// one. These assertions pin the rule that keeps that from happening.

import { describe, expect, test } from "bun:test";
import { statusFor } from "../scripts/sync-project.ts";

const labelled = (...names: string[]) => ({ labels: names.map((name) => ({ name })) });

describe("statusFor", () => {
  test("an agent-ready issue with nothing blocking it is Ready", () => {
    expect(statusFor(labelled("type: fix", "agent-ready"), false)).toBe("Ready");
  });

  test("an issue nobody has scoped stays in the backlog", () => {
    // No `agent-ready` means the body is not yet a brief. Handing it to an
    // agent is handing over a note to self.
    expect(statusFor(labelled("type: feat"), false)).toBe("Backlog");
  });

  test("a `needs:` label takes it out of Ready, whatever else it carries", () => {
    for (const need of ["needs: decision", "needs: design", "needs: repro", "needs: human", "needs: use-case"]) {
      expect(statusFor(labelled("agent-ready", need), false)).toBe("Backlog");
    }
  });

  test("a sibling blocker takes it out of Ready", () => {
    // A container hardening chain is the real case: relocation, then the
    // user, then the agent uid, then the docs. Three of the four are
    // `agent-ready` and only the first is pickable.
    expect(statusFor(labelled("agent-ready", "blocked"), false)).toBe("Backlog");
  });

  test("an epic is never Ready, even when it looks complete", () => {
    // The work is in the sub-issues; the epic itself is never coded.
    expect(statusFor(labelled("epic", "agent-ready"), false)).toBe("Backlog");
  });

  test("an open PR beats every label", () => {
    // Including the two that would otherwise force Backlog: a PR exists, so
    // the issue is in review regardless of how it was labelled.
    expect(statusFor(labelled("agent-ready"), true)).toBe("In review");
    expect(statusFor(labelled("epic"), true)).toBe("In review");
    expect(statusFor(labelled("blocked", "needs: decision"), true)).toBe("In review");
  });
});
