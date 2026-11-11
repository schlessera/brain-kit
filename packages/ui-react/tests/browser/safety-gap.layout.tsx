/**
 * #3812: a safety-recording failure restricts what it puts at risk, never
 * more. One chat keeps a permanent recording gap, written by the real host
 * when its search result's record was refused; a second chat, started from
 * the real Chat page, sends, is answered and keeps sending, under normal
 * policy. The brain-wide recorder never latches.
 */
import { expect, test } from "vitest";
import { commands } from "vitest/browser";

test("a second chat stays usable while one chat carries a recording gap", async () => {
  const r = await commands.safetyGapChats();
  const gapped = r.gapped.turns[0]!.sessionId;
  expect(r.gapped.chats[gapped], "BROWSER_FIRST_CHAT_KEEPS_A_RECORDING_GAP").toEqual({ restriction: "restricted", coverage: "incomplete", gap: true, available: true });
  expect(r.gapped.brainLatched, "BROWSER_CHAT_GAP_NEVER_LATCHES_THE_BRAIN").toBe(false);
  const second = r.after.turns.filter(t => t.sessionId !== gapped);
  expect(second.map(t => [t.prompt, t.outcome]), "BROWSER_SECOND_CHAT_RUNS_EVERY_TURN")
    .toEqual([["Steer for Ithaca.", "success"], ["Row past Scylla.", "success"]]);
  expect(new Set(second.map(t => t.sessionId)).size, "BROWSER_SECOND_CHAT_IS_ONE_CHAT").toBe(1);
  expect(r.after.chats[second[0]!.sessionId], "BROWSER_SECOND_CHAT_STAYS_NORMAL").toEqual({ restriction: "normal", coverage: "complete", gap: false, available: true });
  expect(r.after.chats[gapped], "BROWSER_FIRST_CHAT_GAP_IS_PERMANENT").toMatchObject({ restriction: "restricted", gap: true });
  expect(r.after.brainLatched).toBe(false);
  expect(r.refusalCopy, "BROWSER_SECOND_CHAT_SHOWS_NO_REFUSAL").toBe(false);
  expect(r.composerDisabled, "BROWSER_SECOND_CHAT_COMPOSER_STAYS_ENABLED").not.toBe("true");
  expect(r.diagnostics).toEqual([]);
}, 60_000);
