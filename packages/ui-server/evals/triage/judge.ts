/**
 * The judge panel's pure half: vote tallying and the per-item verdict.
 *
 * validate.ts owns the provider calls and refuses to start without the
 * live-eval opt-in, so nothing in it can be imported by a keyless test. What
 * decides what a set of judge answers MEANS lives here instead, and is tested
 * against recorded output in tests/triage-eval.test.ts.
 */

import type { HardItem } from "./dataset.js";
import type { Row } from "./score.js";

/** item -> judge -> route -> count */
export type Votes = Record<string, Record<string, Record<string, number>>>;

/**
 * Fold one judge's batch response into the vote table. A row that never
 * arrived, or arrived without a route, is not a vote — the judge simply did
 * not answer, and an unanswered item cannot be endorsed.
 */
export function recordVotes(votes: Votes, batch: HardItem[], judge: string, rows: Row[]): void {
  for (const item of batch) {
    const got = rows.find((r) => r?.id === item.id);
    if (!got?.route) continue;
    const byJudge = (votes[item.id] ??= {});
    const byRoute = (byJudge[judge] ??= {});
    byRoute[got.route] = (byRoute[got.route] ?? 0) + 1;
  }
}

/** A judge's most frequent route across reps; "-" when the judge never answered. */
export const modal = (d: Record<string, number> = {}): string =>
  Object.entries(d).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";

export interface JudgeVerdict {
  /** One modal route per judge, in judge order. */
  modals: string[];
  /** Every judge's modal matches the stored label. */
  endorsed: boolean;
  /** "ok", "RELABEL -> <route>" or "CONTESTED". */
  text: string;
}

/**
 * "ok" only when every judge's modal vote is the stored label. Judges that
 * unanimously prefer another route say RELABEL; anything else — including a
 * judge that never answered, since silence agrees with nobody — is CONTESTED.
 */
export function judgeItem(item: HardItem, votes: Votes, judges: string[]): JudgeVerdict {
  const perJudge = votes[item.id] ?? {};
  const modals = judges.map((j) => modal(perJudge[j]));
  const endorsed = modals.every((m) => m === item.gold.route);
  const judgesAgree = new Set(modals).size === 1 && modals[0] !== "-";
  const text = endorsed ? "ok" : judgesAgree ? `RELABEL -> ${modals[0]}` : "CONTESTED";
  return { modals, endorsed, text };
}
