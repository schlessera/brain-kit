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
  HOSTING_AREA_LABELS,
  labelsFor,
  type LabelSpec,
} from "../scripts/labels.ts";
import { planActions } from "../scripts/sync-labels.ts";

const ALL_REPOS = ["brain-kit", "brain-template", "brain-hosting-template"] as const;

describe("label taxonomy", () => {
  for (const repo of ALL_REPOS) {
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

  test("no public label names a private repository, and each repo links only its public counterparts (#299)", () => {
    // A public issue never names, labels or links the maintainer's private
    // instance (AGENTS.md, "The five repositories"). Names and descriptions
    // both render on every issue that carries the label.
    const PRIVATE = /brain-ui(?![-\w])|schlessera\/brain(?![-\w])|\bbrain(?![-\w])\s+repo/;
    for (const repo of ALL_REPOS) {
      const labels = labelsFor(repo);
      expect(labels.length).toBeGreaterThan(0);
      const leaks = labels.filter((l) => PRIVATE.test(l.name) || PRIVATE.test(l.description)).map((l) => l.name);
      expect({ repo, leaks }).toEqual({ repo, leaks: [] });
    }
    const upstream = (repo: (typeof ALL_REPOS)[number]) =>
      labelsFor(repo)
        .map((label) => label.name)
        .filter((n) => n.startsWith("upstream: "))
        .sort();
    expect({
      "brain-kit": upstream("brain-kit"),
      "brain-template": upstream("brain-template"),
      "brain-hosting-template": upstream("brain-hosting-template"),
    }).toEqual({
      "brain-kit": ["upstream: brain-hosting-template", "upstream: brain-template"],
      "brain-template": ["upstream: brain-kit"],
      "brain-hosting-template": ["upstream: brain-kit"],
    });
  });

  test("a namespace is one colour, so the prefix is legible before it is read", () => {
    const namespaced = (prefix: keyof typeof NAMESPACE_COLORS, labels: LabelSpec[]) =>
      labels.filter((label) => label.name.startsWith(`${prefix}: `));

    for (const repo of ALL_REPOS) {
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

  test("the kit and the shell do not share an area vocabulary", () => {
    // brain-kit's areas are packages; the shell's are deployment surfaces. The
    // overlap is deliberate and small — ci and docs exist in both.
    const kit = new Set(KIT_AREA_LABELS.map((label) => label.name));
    const shell = new Set(HOSTING_AREA_LABELS.map((label) => label.name));
    const shared = [...kit].filter((name) => shell.has(name));
    expect(shared.sort()).toEqual(["area: ci", "area: docs"]);
  });

  test("the hosting template speaks the shell's vocabulary, not its own", () => {
    // It IS the extraction of the shell. A parallel vocabulary for the same
    // shape would mean translating every issue that moves between them.
    expect(labelsFor("brain-hosting-template").filter((l) => l.name.startsWith("area: "))).toEqual(
      HOSTING_AREA_LABELS,
    );
  });

  test("every repository can say where an issue lands", () => {
    for (const repo of ALL_REPOS) {
      const areas = labelsFor(repo).filter((label) => label.name.startsWith("area: "));
      expect(areas.length).toBeGreaterThan(2);
    }
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
