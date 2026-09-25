import { defineConfig } from "@schlessera/brain";

/**
 * Test fixture brain for the fictional persona "Alex Example", a park ranger.
 * Deliberately NOT a software/speaking persona: the domains are health,
 * woodworking projects, and evening astronomy studies.
 *
 * This config exercises every taxonomy feature the resolver supports:
 *   - custom types layered over the core built-ins (identity/context/note/index)
 *   - a `match`-override type (project) whose accepted prefix differs from dir
 *   - per-type staleness thresholds + severities (health, project)
 *   - appendMatch, orphanExempt
 *   - classifier hints, propagation, asset-title rules
 *   - canonical defaults (me/identity.md + context/current-focus.md)
 */
export default defineConfig({
  profile: {
    name: "Alex Example",
    cliTitle: "Alex Example's field notebook",
  },

  taxonomy: {
    types: {
      // health notes go stale fast — a warning after 60 days.
      health: { dir: "health", staleDays: 60, staleSeverity: "warning" },
      // active projects live under projects/active, but any path under
      // projects/ (e.g. projects/archive) still classifies as a project.
      // Title-matched `brain add` content appends into the matching project.
      project: {
        dir: "projects/active",
        match: ["projects/"],
        staleDays: 90,
        appendMatch: true,
      },
      // course/lecture study notes.
      study: { dir: "studies" },
      // dated diary entries; wiki-links are not expected, so exempt from the
      // orphan audit.
      journal: { dir: "journal", orphanExempt: true },
    },

    classifierHints: {
      health: ["symptom", "appointment", "prescription", "blood pressure"],
      study: ["chapter", "lecture", "exercise", "course"],
    },

    propagation: [
      // short-bio.md / long-bio.md must not lag behind the canonical FACTS.md.
      { source: "me/basics/FACTS.md", derivatives: "me/basics/*.md" },
    ],

    facts: {
      // FACTS.md holds the value (`facts: { ranger_since: 2019 }`); a bio that
      // restates another year is fact-drift. long-bio.md drifted on purpose.
      ranger_since: { source: "me/basics/FACTS.md", patterns: ["ranger at .{0,80}? since (\\d{4})"] },
    },

    assetTitleRules: [
      // photos under projects/ are titled "Build Photo: <filename>".
      { prefix: "projects/", label: "Build Photo" },
    ],

    // canonical defaults (identity + currentFocus) apply — not overridden here.
    // me/identity.md and context/current-focus.md both exist in this corpus.
  },
});
