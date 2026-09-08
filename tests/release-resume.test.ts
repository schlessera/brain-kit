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

import { planRelease, type ReleaseEntry } from "../scripts/publish.ts";

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
