import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { openDatabase } from "../../lib/db";
import { indexAll } from "../../lib/indexer";
import { validate } from "../../lib/validate";
import { CORE_TYPES } from "../../lib/config";
import type { CoreCommand, CliContext } from "../types";
import { emit, parseArgs, today, UsageError } from "../io";

const HELP = `brain init — preflight check / non-interactive default setup

  --check                 Emit a preflight JSON report (no changes)
  --default               Write a minimal brain.config + core dirs, then index+validate

The conversational interview lives in the /brain-init skill; this command is its
mechanical backend and the keyless CI smoke path.`;

function gitConfig(root: string, key: string): string {
  const proc = Bun.spawnSync(["git", "-C", root, "config", "--get", key]);
  return new TextDecoder().decode(proc.stdout).trim();
}

function isGitRepo(root: string): boolean {
  return (
    existsSync(join(root, ".git")) ||
    Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-dir"]).exitCode === 0
  );
}

/** Directories for every core type that has a canonical dir. */
function coreDirs(): string[] {
  return Object.values(CORE_TYPES)
    .map((spec) => spec.dir)
    .filter((d): d is string => typeof d === "string");
}

function preflight(cli: CliContext): Record<string, unknown> {
  const root = cli.brain.root;
  const hooksPath = gitConfig(root, "core.hooksPath");
  const dirs = coreDirs();
  const present = dirs.filter((d) => existsSync(resolve(root, d)));
  const missing = dirs.filter((d) => !existsSync(resolve(root, d)));

  const config = cli.configError
    ? { exists: true, valid: false, path: cli.brain.configPath, error: cli.configError }
    : cli.brain.config
      ? { exists: true, valid: true, path: cli.brain.configPath }
      : { exists: false, valid: false, path: null };

  return {
    bun: { version: process.versions.bun ?? null, ok: !!process.versions.bun },
    git: { repo: isGitRepo(root) },
    hooksPath: { set: hooksPath.length > 0, value: hooksPath || null },
    config,
    contentDirs: { present, missing },
    keys: {
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    },
  };
}

// init --default is the keyless, dependency-free fallback: it must work in a
// bare directory with no node_modules, so it writes brain.config.json (no
// imports) rather than a .ts config that needs "@endoxa/core" resolvable.
// The guided /brain-init interview upgrades users to brain.config.ts.
const MINIMAL_CONFIG_JSON = `${JSON.stringify({}, null, 2)}\n`;

function rootIndex(): string {
  const day = today();
  return `---
type: index
title: "Brain Index"
created: ${day}
updated: ${day}
tags: [index]
status: active
relevance: primary
summary: "Top-level map of this brain"
---

## Map

Root registry for this brain. Add sections as you create content.
`;
}

async function initDefault(cli: CliContext): Promise<Record<string, unknown>> {
  const root = cli.brain.root;
  const created: string[] = [];

  // 1. Config (only if absent — never overwrite user config).
  const configPath = join(root, "brain.config.json");
  const configExists = existsSync(join(root, "brain.config.ts")) || existsSync(configPath);
  if (!configExists) {
    writeFileSync(configPath, MINIMAL_CONFIG_JSON, "utf-8");
    created.push("brain.config.json");
  }

  // 2. Core-type directories.
  for (const dir of coreDirs()) {
    const full = resolve(root, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      created.push(`${dir}/`);
    }
  }

  // 3. Root _index.md (only if absent).
  const indexPath = join(root, "_index.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, rootIndex(), "utf-8");
    created.push("_index.md");
  }

  // 4. Empty sidecar caches (contract: templates ship them empty).
  for (const sidecar of [".context-cache.jsonl", ".asset-cache.jsonl"]) {
    const p = join(root, sidecar);
    if (!existsSync(p)) {
      writeFileSync(p, "", "utf-8");
      created.push(sidecar);
    }
  }

  // 5. Index + validate. The just-written minimal config is core-defaults only,
  // which is exactly what cli.brain.taxonomy already reflects.
  const db = openDatabase(cli.brain.dbPath);
  const stats = await indexAll(db, {
    root,
    taxonomy: cli.brain.taxonomy,
    force: false,
    quiet: true,
  });
  db.close();

  const issues = validate(root, cli.brain.taxonomy);
  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warning").length;

  return {
    config: configExists ? { created: false } : { created: true, path: "brain.config.json" },
    created,
    indexed: stats,
    validation: { errors, warnings },
  };
}

export const initCommand: CoreCommand = {
  summary: "Preflight check (--check) or non-interactive default setup (--default)",
  helpBlock: HELP,
  async run(args, cli) {
    const { flags } = parseArgs(args);

    if (flags.check === true) {
      emit(cli.json, preflight(cli), () => {
        const p = preflight(cli);
        console.log("brain init --check (preflight):");
        console.log(JSON.stringify(p, null, 2));
      });
      return;
    }

    if (flags.default === true) {
      const result = await initDefault(cli);
      emit(cli.json, result, () => {
        console.log("brain init --default complete:");
        console.log(`  created: ${(result.created as string[]).join(", ") || "(nothing — already initialized)"}`);
        const idx = result.indexed as { total: number };
        console.log(`  indexed: ${idx.total} document(s)`);
        const v = result.validation as { errors: number; warnings: number };
        console.log(`  validation: ${v.errors} error(s), ${v.warnings} warning(s)`);
      });
      return;
    }

    throw new UsageError("Usage: brain init --check | brain init --default");
  },
};
