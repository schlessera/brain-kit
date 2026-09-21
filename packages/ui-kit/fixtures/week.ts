// The weekly review: seven days of the brain's own work, told back to the owner.
//
// This is §11.3 of the catalog, the deepest composition in the design drop, and
// it is a REVIEW rather than a new kind of content -- it reports on the same
// week the other modules already describe. So the numbers here are pinned to
// the ones that already exist: the spend comes from `money.ts`, the failures
// from the dead-lettered fetch in `actions.ts`, the stale premise from the wind
// forecast in `runs.ts`, and the two carried decisions are the approval and the
// choose that `actions.ts` leaves open.
//
// Everything countable closes, and `tests/fixtures.test.ts` asserts it:
// decisions plus digests is the run count, answered plus carried is the
// decisions offered, and the percentage is computed rather than typed.

import type { ListRowProps } from "../src/rows/ListRow.js";
import { actions } from "./actions.js";
import { daysAfter } from "./time.js";

/** Seven days, ending on the reference date. */
export const weekDays = 7;

/**
 * Every run the week produced. It is exactly the decisions the brain escalated
 * plus one digest a day -- a week in which the brain asked 34 questions and
 * filed 7 summaries, and did nothing else worth counting.
 */
export const weekDecisionsOffered = 34;
export const weekRuns = weekDecisionsOffered + weekDays;

/**
 * The two that are still open are the two `actions.ts` leaves open, which is
 * why the carried list below has exactly those two decisions in it.
 */
export const weekDecisionsCarried = 2;
export const weekDecisionsAnswered = weekDecisionsOffered - weekDecisionsCarried;

/** Derived, so the bar and the figure cannot drift apart. */
export const weekAnsweredPct = Math.round((weekDecisionsAnswered / weekDecisionsOffered) * 100);

/** The three attempts on `winds.example.invalid`, dead-lettered in `actions.ts`. */
export const weekFailedFetches = 3;

/** The `ScreenHeader` meta line: two facts, no adjectives. */
export const weekHeaderMeta = `${weekDays} days · ${weekRuns} runs`;

/**
 * The filter pills. Counts live inside the label, which is `FilterRow`'s rule,
 * and the two kinds partition the run count rather than overlapping it.
 */
export const weekFilters = [
  `all ${weekRuns}`,
  `decisions ${weekDecisionsOffered}`,
  `digests ${weekDays}`,
  `failed ${weekFailedFetches}`,
];

/**
 * "What changed", as two group rows: one number that went well and one that did
 * not. The failing row is the only one on the screen with an action, because it
 * is the only one with somewhere to go.
 */
export const weekChanges: ListRowProps[] = [
  {
    icon: "resolved",
    title: "Decisions you answered",
    subtitle: `${weekDecisionsAnswered} of ${weekDecisionsOffered} · median 4m`,
    value: `${weekAnsweredPct}%`,
    valueTone: "teal",
  },
  {
    icon: "failed",
    title: "source-watch dead-lettered",
    subtitle: `${weekFailedFetches} fetches to winds.example.invalid · NXDOMAIN each time`,
    actionLabel: "Open",
  },
];

/**
 * The standing-rule suggestion. It is the one `actions.ts` already carries --
 * the review reports on the week rather than inventing a new offer -- plus the
 * two button labels the card needs and the fixture, which describes a card
 * rather than a screen, has no place to put.
 */
const suggestion = actions.find((a) => a.kind === "suggestion")!;

/**
 * `primaryLabel` is two words on purpose. A `size="md"` Button carrying an
 * effect chip, sharing a row at phone width, has ~136px of content box -- and
 * the chip claims about half of it, because the chip names what the tap DOES
 * and is the half that must not be abbreviated. Recorded in
 * `docs/decisions/design-feedback.md`; the component no longer spills when it happens,
 * but the label still has to fit.
 */
export const weekSuggestion = {
  title: suggestion.title,
  body: suggestion.body,
  rightMeta: suggestion.rightMeta!,
  primaryLabel: "Write rule",
  primaryEffect: "write_policy",
  secondaryLabel: "Not yet",
};

/**
 * What next week inherits. Two decisions nobody answered and one premise that
 * has gone stale underneath a project -- all three already exist elsewhere in
 * the world, which is the point: a review that invents its own backlog is not
 * reviewing anything.
 */
export const weekCarried: ListRowProps[] = [
  {
    icon: "approval",
    iconSize: 14,
    variant: "plain",
    title: "Fetch the wind forecast once",
    value: "snoozed 2d",
  },
  {
    icon: "choose",
    iconSize: 14,
    variant: "plain",
    title: "Where the eagle omen lives",
    value: "snoozed 4d",
  },
  {
    icon: "unverified",
    iconSize: 14,
    variant: "plain",
    title: "wind: west, holds 17 days",
    value: "premise stale",
  },
];

/** The count on the "Carried into next week" label. */
export const weekCarriedCount = weekCarried.length;

/** The closing banner. Next week's review lands with the digest hour. */
export const weekFootnote = `next review ${daysAfter(weekDays)} 04:30 · ${weekCarriedCount} carried, none urgent`;
