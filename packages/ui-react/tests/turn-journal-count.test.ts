// The collapsed turn receipt counts retained files only (#3255). An index-only
// turn reads as zero files; a summary from before keptFiles names entries.
import { expect, test } from "bun:test";
import type { TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";
import { turnJournalChangeCount } from "../src/components/chat/turn-journal-count.js";

const summary = (facts: Partial<TurnJournalSummary>): TurnJournalSummary => ({ state: "complete", changedFiles: 1, steeringFiles: 0, costUsd: null, costIsEstimate: null,
  profile: "governed", actor: "interactive", model: null, policyHash: null, sharedAttribution: false, observedAt: Date.UTC(2026, 6, 12), ...facts });

test("the collapsed count names retained files, never index or ignored entries", () => {
  expect(turnJournalChangeCount(summary({ changedFiles: 1, keptFiles: 0 })), "INDEX_ONLY_TURN_READS_ZERO_FILES").toBe("0 changed files");
  expect(turnJournalChangeCount(summary({ changedFiles: 7, keptFiles: 1 }))).toBe("1 changed file");
  expect(turnJournalChangeCount(summary({ changedFiles: 7, keptFiles: 4 }))).toBe("4 changed files");
});

test("a partial journal's count is a lower bound", () => {
  expect(turnJournalChangeCount(summary({ state: "partial", changedFiles: 2, keptFiles: 1 })), "PARTIAL_IS_AT_LEAST").toBe("At least 1 changed file");
  expect(turnJournalChangeCount(summary({ state: "partial", changedFiles: 2 }))).toBe("At least 2 entries recorded");
});

test("a summary without keptFiles names recorded entries, never files; unknown stays unknown", () => {
  expect(turnJournalChangeCount(summary({ changedFiles: 1 })), "LEGACY_SUMMARY_NAMES_ENTRIES").toBe("1 entry recorded");
  expect(turnJournalChangeCount(summary({ changedFiles: 3, keptFiles: null })), "UNKNOWN_KEPT_NAMES_ENTRIES").toBe("3 entries recorded");
  expect(turnJournalChangeCount(summary({ state: "expired", changedFiles: 0 }))).toBe("0 entries recorded");
  expect(turnJournalChangeCount(summary({ state: "unknown", changedFiles: null, keptFiles: null })), "UNKNOWN_NEVER_ZERO").toBe("Changes unknown");
  expect(turnJournalChangeCount(undefined)).toBe("Changes unknown");
});
