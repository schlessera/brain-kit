/**
 * Core command table. Each entry maps a top-level command word to its one-line
 * summary and a loader for its implementation, so `brain --help` and the
 * dispatch of one command import that command alone. Order here is the
 * canonical order used in `brain --help` before the module commands (which are
 * appended, sorted).
 *
 * Each `import()` names its file as a string literal: CI's affected-test
 * planner follows literal dynamic imports. A row's `summary` equals the
 * `summary` of the command `load` returns (`cli-command-table.test.ts`).
 */

import type { CoreCommand } from "../types.js";

export interface CoreCommandEntry {
  summary: string;
  load(): Promise<CoreCommand>;
}

export const CORE_COMMANDS: Record<string, CoreCommandEntry> = {
  search: {
    summary: "Hybrid search across the knowledge base",
    load: async () => (await import("./search.js")).searchCommand,
  },
  context: {
    summary: "Assemble a context block for agent consumption",
    load: async () => (await import("./context.js")).contextCommand,
  },
  read: {
    summary: "Read and print a document from the brain",
    load: async () => (await import("./read.js")).readCommand,
  },
  "read-many": {
    summary: "Read several documents or sections under one size cap",
    load: async () => (await import("./read-many.js")).readManyCommand,
  },
  list: {
    summary: "List/browse documents",
    load: async () => (await import("./list.js")).listCommand,
  },
  briefing: {
    summary: "Emit a mechanical daily briefing (deadlines, reviews, silent edits)",
    load: async () => (await import("./briefing.js")).briefingCommand,
  },
  add: {
    summary: "Quick-add content to the brain",
    load: async () => (await import("./add.js")).addCommand,
  },
  index: {
    summary: "Update the search index (incremental by default)",
    load: async () => (await import("./index-cmd.js")).indexCommand,
  },
  validate: {
    summary: "Run config, frontmatter, link, and index-drift validation",
    load: async () => (await import("./validate.js")).validateCommand,
  },
  audit: {
    summary: "Run staleness and quality audit",
    load: async () => (await import("./audit.js")).auditCommand,
  },
  process: {
    summary: "Assimilate a note into proper brain content",
    load: async () => (await import("./process.js")).processCommand,
  },
  archive: {
    summary: "Archive a document (set status: archived)",
    load: async () => (await import("./archive.js")).archiveCommand,
  },
  "accept-mtime": {
    summary: "Baseline current file mtimes so silent-edit checks stop flagging them",
    load: async () => (await import("./accept-mtime.js")).acceptMtimeCommand,
  },
  maintain: {
    summary: "Run routine maintenance: registry tables, incremental index, vector compaction, audit snapshot, stats history, tag report, git packing, scratch prune",
    load: async () => (await import("./maintain.js")).maintainCommand,
  },
  registry: {
    summary: "Regenerate _index.md registry tables from the children's frontmatter",
    load: async () => (await import("./registry.js")).registryCommand,
  },
  stats: {
    summary: "Show corpus statistics",
    load: async () => (await import("./stats.js")).statsCommand,
  },
  storage: {
    summary: "Bounded storage inventory and non-destructive Git packing",
    load: async () => (await import("./storage.js")).storageCommand,
  },
  graph: {
    summary: "Inspect and rebuild the derived wiki-link graph",
    load: async () => (await import("./graph.js")).graphCommand,
  },
  geo: {
    summary: "Geocode, route, find POIs, measure tracks and export static maps",
    load: async () => (await import("./geo.js")).geoCommand,
  },
  render: {
    summary: "Render a document to PDF, PNG, or standalone HTML",
    load: async () => (await import("./render.js")).renderCommand,
  },
  scratch: {
    summary: "Clean or prune the brain's scratch area",
    load: async () => (await import("./scratch.js")).scratchCommand,
  },
  sync: {
    summary: "Sync the brain with its git remote (run the whole sync, or one verb of it)",
    load: async () => (await import("./sync.js")).syncCommand,
  },
  setup: {
    summary: "Idempotent setup: git hooks, skills sync, bin links",
    load: async () => (await import("./setup.js")).setupCommand,
  },
  doctor: {
    summary: "Run the health check battery (add --fix to auto-repair)",
    load: async () => (await import("./doctor.js")).doctorCommand,
  },
  init: {
    summary: "Preflight check (--check) or non-interactive default setup (--default)",
    load: async () => (await import("./init.js")).initCommand,
  },
  import: {
    summary: "Mechanical frontmatter stamping for imported markdown",
    load: async () => (await import("./import.js")).importCommand,
  },
  skills: {
    summary: "Distribute (sync) or lint the skill suite",
    load: async () => (await import("./skills.js")).skillsCommand,
  },
  module: {
    summary: "List, lint, enable or disable brain-kit modules and edit their settings",
    load: async () => (await import("./module.js")).moduleCommand,
  },
  config: {
    summary: "Validate config / read effective taxonomy and config values",
    load: async () => (await import("./config.js")).configCommand,
  },
  mcp: {
    summary: "Start the stdio MCP server",
    load: async () => (await import("./mcp.js")).mcpCommand,
  },
  okf: {
    summary: "Export or validate an Open Knowledge Format v0.1 bundle",
    load: async () => (await import("./okf.js")).okfCommand,
  },
  eval: {
    summary: "Score a retrieval query set against this brain's index",
    load: async () => (await import("./eval.js")).evalCommand,
  },
  tags: {
    summary: "Report tag variants, redundant tags and vocabulary drift (read-only)",
    load: async () => (await import("./tags.js")).tagsCommand,
  },
  hygiene: {
    summary: "Reconcile, read and triage the content-hygiene log",
    load: async () => (await import("./hygiene.js")).hygieneCommand,
  },
  queue: {
    summary: "Queue intake on a UI server without filing content",
    load: async () => (await import("./queue.js")).queueCommand,
  },
  schedule: {
    summary: "Manage scheduled tasks on a UI host (no local runner)",
    load: async () => (await import("./schedule.js")).scheduleCommand,
  },
  policy: {
    summary: "Validate the read-only governance policy without loading brain configuration",
    load: async () => (await import("./policy.js")).policyCommand,
  },
  compute: {
    summary: "External compute: plan, run, inspect, cancel and collect jobs on a configured provider",
    load: async () => (await import("./compute.js")).computeCommand,
  },
  apify: {
    summary: "Discover, inspect and run Apify Actors under the governance policy",
    load: async () => (await import("./apify.js")).apifyCommand,
  },
};
