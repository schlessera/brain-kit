// The label taxonomy is a contract between the issue tracker, the project
// board and the agents that read both. These assertions pin the properties
// `docs/process/github.md` tells a reader to rely on, and the two GitHub API
// limits that fail a sync silently rather than loudly.

import { describe, expect, test } from "bun:test";
import {
  KIT_AREA_LABELS,
  NAMESPACE_COLORS,
  OBSOLETE_LABELS,
  PRIORITY_LABELS,
  UI_AREA_LABELS,
  labelsFor,
  type LabelSpec,
} from "../scripts/labels.ts";
import { planActions } from "../scripts/sync-labels.ts";

const BOTH_REPOS = ["brain-kit", "brain-ui"] as const;

describe("label taxonomy", () => {
  for (const repo of BOTH_REPOS) {
    const labels = labelsFor(repo);

    test(`${repo}: every name is unique`, () => {
      const names = labels.map((label) => label.name);
      expect(new Set(names).size).toBe(names.length);
    });

    test(`${repo}: every label has a description`, () => {
      const undescribed = labels.filter((label) => label.description.trim() === "");
      expect(undescribed).toEqual([]);
    });

    test(`${repo}: descriptions fit GitHub's 100-character limit`, () => {
      // GitHub truncates past 100 with no error, so a long description syncs
      // "successfully" and arrives cut mid-word.
      const tooLong = labels
        .filter((label) => label.description.length > 100)
        .map((label) => `${label.name} (${label.description.length})`);
      expect(tooLong).toEqual([]);
    });

    test(`${repo}: colours are bare six-digit hex`, () => {
      // `gh label create --color` rejects a leading #, and a three-digit shade
      // is accepted by the API but renders differently from what was meant.
      const malformed = labels
        .filter((label) => !/^[0-9a-f]{6}$/.test(label.color))
        .map((label) => `${label.name}=${label.color}`);
      expect(malformed).toEqual([]);
    });

    test(`${repo}: no wanted label is also on the obsolete list`, () => {
      const collisions = labels
        .map((label) => label.name)
        .filter((name) => OBSOLETE_LABELS.includes(name));
      expect(collisions).toEqual([]);
    });
  }

  test("a namespace is one colour, so the prefix is legible before it is read", () => {
    const namespaced = (prefix: keyof typeof NAMESPACE_COLORS, labels: LabelSpec[]) =>
      labels.filter((label) => label.name.startsWith(`${prefix}: `));

    for (const repo of BOTH_REPOS) {
      const labels = labelsFor(repo);
      for (const prefix of Object.keys(NAMESPACE_COLORS) as (keyof typeof NAMESPACE_COLORS)[]) {
        const group = namespaced(prefix, labels);
        expect(group.length).toBeGreaterThan(0);
        for (const label of group) expect(label.color).toBe(NAMESPACE_COLORS[prefix]);
      }
    }
  });

  test("the type namespace is closed", () => {
    // Exactly one `type:` goes on an issue, so the set has to be small enough
    // that the choice is obvious. Adding one is a deliberate act.
    expect(labelsFor("brain-kit").filter((l) => l.name.startsWith("type: ")).map((l) => l.name)).toEqual([
      "type: feat",
      "type: fix",
      "type: refactor",
      "type: test",
      "type: docs",
      "type: chore",
      "type: spike",
    ]);
  });

  test("priority is exactly p0 through p3, in order", () => {
    expect(PRIORITY_LABELS.map((label) => label.name)).toEqual([
      "priority: p0",
      "priority: p1",
      "priority: p2",
      "priority: p3",
    ]);
  });

  test("every shipped package has an area label", () => {
    // An issue that cannot name where it lands is an issue nobody can route.
    const areas = new Set(KIT_AREA_LABELS.map((label) => label.name.replace("area: ", "")));
    for (const area of [
      "core",
      "modules",
      "ui-sdk",
      "ui-server",
      "ui-react",
      "ui-kit",
      "backends",
      "render",
      "scrape",
      "template",
    ]) {
      expect(areas).toContain(area);
    }
  });

  test("the two repos do not share an area vocabulary", () => {
    // brain-kit's areas are packages; brain-ui's are deployment surfaces. The
    // overlap is deliberate and small — ci and docs exist in both.
    const kit = new Set(KIT_AREA_LABELS.map((label) => label.name));
    const shell = new Set(UI_AREA_LABELS.map((label) => label.name));
    const shared = [...kit].filter((name) => shell.has(name));
    expect(shared.sort()).toEqual(["area: ci", "area: docs"]);
  });
});

describe("sync plan", () => {
  const wanted: LabelSpec[] = [
    { name: "type: feat", color: "1d76db", description: "A new capability." },
    { name: "epic", color: "3e4b9e", description: "A tracking issue." },
  ];

  test("an absent label is created", () => {
    const actions = planActions(wanted, [], { prune: false });
    expect(actions.map((action) => action.kind)).toEqual(["create", "create"]);
  });

  test("a label already in place produces no action", () => {
    const actions = planActions(wanted, wanted, { prune: false });
    expect(actions).toEqual([]);
  });

  test("a drifted colour or description is updated, not recreated", () => {
    const existing = [
      { name: "type: feat", color: "ffffff", description: "A new capability." },
      { name: "epic", color: "3e4b9e", description: "stale" },
    ];
    const actions = planActions(wanted, existing, { prune: false });
    expect(actions.map((action) => action.kind)).toEqual(["update", "update"]);
  });

  test("colour comparison is case-insensitive, because the API answers in lowercase", () => {
    const existing = [
      { name: "type: feat", color: "1D76DB", description: "A new capability." },
      { name: "epic", color: "3e4b9e", description: "A tracking issue." },
    ];
    expect(planActions(wanted, existing, { prune: false })).toEqual([]);
  });

  test("a superseded default is deleted without --prune", () => {
    const existing = [...wanted, { name: "bug", color: "d73a4a", description: "" }];
    const actions = planActions(wanted, existing, { prune: false });
    expect(actions).toEqual([{ kind: "delete", name: "bug", reason: "obsolete" }]);
  });

  test("an unrecognized label survives without --prune and is deleted with it", () => {
    const existing = [...wanted, { name: "hand-made", color: "000000", description: "" }];
    expect(planActions(wanted, existing, { prune: false })).toEqual([]);
    expect(planActions(wanted, existing, { prune: true })).toEqual([
      { kind: "delete", name: "hand-made", reason: "unknown" },
    ]);
  });
});
