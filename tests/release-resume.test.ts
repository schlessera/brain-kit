/**
 * A partial release must be finishable by re-running it.
 *
 * The 0.32.0 release published five of thirteen packages and then stopped,
 * because the registry took longer than the confirmation budget to serve a
 * package that had in fact published. Re-running died immediately with
 * `403 You cannot publish over the previously published versions` on the first
 * package the earlier run had already got out, and the documented recovery was
 * to comment names out of the hardcoded list in `scripts/publish.ts` and
 * remember to restore them afterwards — a hand edit to release tooling in the
 * middle of a broken release.
 *
 * `planRelease` removes that step: it asks the registry what is live before
 * publishing anything, so re-running continues where the previous run stopped.
 */
import { describe, expect, test } from "bun:test";

import { awaitPublished, planRelease, type ReleaseEntry } from "../scripts/publish.ts";

/** The 0.32.0 list, in its dependency-first publish order. */
const ENTRIES: ReleaseEntry[] = [
  { dir: "render-template", name: "@schlessera/brain-render-template", version: "0.32.0" },
  { dir: "core", name: "@schlessera/brain", version: "0.32.0" },
  { dir: "ui-sdk", name: "@schlessera/brain-ui-sdk", version: "0.32.0" },
  { dir: "ui-backend-claude", name: "@schlessera/brain-backend-claude", version: "0.32.0" },
  { dir: "ui-backend-pi", name: "@schlessera/brain-backend-pi", version: "0.32.0" },
  { dir: "ui-render-puppeteer", name: "@schlessera/brain-render-puppeteer", version: "0.32.0" },
  { dir: "scrape", name: "@schlessera/brain-scrape", version: "0.32.0" },
  { dir: "ui-server", name: "@schlessera/brain-ui-server", version: "0.32.0" },
];

/** A registry stub: every (name, version) pair it was told is already out. */
function registry(live: readonly string[]): {
  isLive: (name: string, version: string) => Promise<boolean>;
  asked: string[];
} {
  const asked: string[] = [];
  const set = new Set(live);
  return {
    asked,
    isLive: async (name, version) => {
      asked.push(`${name}@${version}`);
      return set.has(`${name}@${version}`);
    },
  };
}

describe("planRelease", () => {
  test("publishes everything when nothing is live yet", async () => {
    const { isLive } = registry([]);

    const plan = await planRelease(ENTRIES, isLive);

    expect(plan.map((step) => step.action)).toEqual(ENTRIES.map(() => "publish"));
  });

  // The exact 0.32.0 shape: the first five were live, the run had stopped on
  // the fifth's confirmation, and the remainder still had to go out.
  test("skips the versions a previous run already published", async () => {
    const { isLive } = registry([
      "@schlessera/brain-render-template@0.32.0",
      "@schlessera/brain@0.32.0",
      "@schlessera/brain-ui-sdk@0.32.0",
      "@schlessera/brain-backend-claude@0.32.0",
      "@schlessera/brain-backend-pi@0.32.0",
    ]);

    const plan = await planRelease(ENTRIES, isLive);

    expect(plan.filter((step) => step.action === "skip").map((step) => step.dir)).toEqual([
      "render-template",
      "core",
      "ui-sdk",
      "ui-backend-claude",
      "ui-backend-pi",
    ]);
    expect(plan.filter((step) => step.action === "publish").map((step) => step.dir)).toEqual([
      "ui-render-puppeteer",
      "scrape",
      "ui-server",
    ]);
  });

  test("re-running a finished release publishes nothing", async () => {
    const { isLive } = registry(ENTRIES.map((entry) => `${entry.name}@${entry.version}`));

    const plan = await planRelease(ENTRIES, isLive);

    expect(plan.every((step) => step.action === "skip")).toBe(true);
  });

  // The list is ordered so a dependency always publishes before its dependents.
  // A plan that reordered — or dropped — an entry would break that guarantee in
  // exactly the window the ordering exists to protect.
  test("preserves the dependency-first order and every entry", async () => {
    const { isLive, asked } = registry(["@schlessera/brain-ui-sdk@0.32.0"]);

    const plan = await planRelease(ENTRIES, isLive);

    expect(plan.map((step) => step.dir)).toEqual(ENTRIES.map((entry) => entry.dir));
    expect(asked).toEqual(ENTRIES.map((entry) => `${entry.name}@${entry.version}`));
  });

  // A version that differs from what is live must still publish: the probe is
  // per (name, version), not per package, so a re-release of a new version
  // after a partial one is not mistaken for work already done.
  test("a live older version does not mask the version being released", async () => {
    const { isLive } = registry(["@schlessera/brain-ui-sdk@0.31.0"]);

    const plan = await planRelease(ENTRIES, isLive);

    expect(plan.every((step) => step.action === "publish")).toBe(true);
  });
});

// Publishes go out back to back and are confirmed as one set afterwards. The
// 0.36.0 release showed why: confirming between publishes stretched the run
// far enough for the npm web-login session to expire, and the sixth publish
// died with a 403 on the login callback. A `bun publish` that exits 0 is
// already accepted by the registry, so the wait belongs after the last one.
describe("awaitPublished", () => {
  const PUBLISHED = ENTRIES.slice(0, 3);
  const noSleep = async () => {};

  test("resolves once every version is seen, without sleeping first", async () => {
    const { isLive } = registry(PUBLISHED.map((entry) => `${entry.name}@${entry.version}`));
    const slept: number[] = [];

    await awaitPublished(PUBLISHED, isLive, async (ms) => {
      slept.push(ms);
    });

    expect(slept).toEqual([]);
  });

  test("keeps polling only the versions still absent, and stops when the set is complete", async () => {
    const live = new Set<string>([`${ENTRIES[0].name}@${ENTRIES[0].version}`]);
    const asked: string[] = [];
    let rounds = 0;
    const isLive = async (name: string, version: string) => {
      asked.push(`${name}@${version}`);
      return live.has(`${name}@${version}`);
    };
    const sleep = async () => {
      rounds += 1;
      // The registry catches up over two rounds.
      if (rounds === 1) live.add(`${ENTRIES[1].name}@${ENTRIES[1].version}`);
      if (rounds === 2) live.add(`${ENTRIES[2].name}@${ENTRIES[2].version}`);
    };

    await awaitPublished(PUBLISHED, isLive, sleep);

    expect(rounds).toBe(2);
    // Round 1 asks all three; round 2 the two still absent; round 3 the last.
    expect(asked).toEqual([
      `${ENTRIES[0].name}@0.32.0`,
      `${ENTRIES[1].name}@0.32.0`,
      `${ENTRIES[2].name}@0.32.0`,
      `${ENTRIES[1].name}@0.32.0`,
      `${ENTRIES[2].name}@0.32.0`,
      `${ENTRIES[2].name}@0.32.0`,
    ]);
  });

  // There is no deadline: `changeset tag` must not run before every version is
  // seen, and nothing after the poll depends on speed. 0.32.0 gave up on a
  // healthy publish that merely took longer than a budget to appear.
  test("waits past any budget, backing off to once a minute, until the last version appears", async () => {
    let calls = 0;
    const slept: number[] = [];
    const isLive = async () => {
      calls += 1;
      return calls >= 40;
    };

    await awaitPublished([ENTRIES[0]], isLive, async (ms) => {
      slept.push(ms);
    });

    expect(calls).toBe(40);
    expect(slept).toHaveLength(39);
    expect(slept.slice(0, 8)).toEqual([2000, 5000, 10000, 15000, 25000, 30000, 45000, 60000]);
    expect(new Set(slept.slice(8))).toEqual(new Set([60000]));
  });

  test("an empty set needs no registry round trip", async () => {
    const { isLive, asked } = registry([]);

    await awaitPublished([], isLive, noSleep);
    expect(asked).toEqual([]);
  });
});
