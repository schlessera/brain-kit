/**
 * CLI I/O primitives shared by every command: argument parsing, output-mode
 * selection, the JSON/human emitter, and the db-open helpers.
 *
 * Ported from the reference brain's brain-cli.ts (:22-97): the same output-mode
 * rule (JSON when stdout is not a TTY; `--json`/`--human` override), the same
 * "boolean flags never consume the following argument" parser, and the same
 * "database not found" guard. New here: an explicit known-flag set so a
 * genuinely unknown `--flag` is a usage error (exit 1) rather than silently
 * ignored, and NO_COLOR is honored (human output is plain text, so this is a
 * guarantee rather than a transformation).
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

import type { BrainContext } from "../lib/context";
import { openDatabase } from "../lib/db";
import { EMBEDDING_DIMENSIONS } from "../lib/models";
import type { EmbeddingProvider } from "../lib/seams";

/** Thrown for user/usage errors → exit code 1. Any other error → exit code 2. */
export class UsageError extends Error {}

/** True when ANSI color must be suppressed (honored by any colorized output). */
export const NO_COLOR = !!process.env.NO_COLOR;

export type Flags = Record<string, string | boolean>;

/**
 * Flags that never take a value. Without this set, `--flag <arg>` would swallow
 * the next positional (e.g. `search --include-archived agentic` loses the
 * query). Superset across all core commands.
 */
export const BOOLEAN_FLAGS = new Set([
  "json", "human", "help",
  "include-archived", "assets-only",
  "smart",
  "incremental", "embeddings", "force", "quiet",
  "fix",
  "keep-note", "all",
  "dry-run",
  "check", "default",
]);

/** Flags that take a value. Used together with BOOLEAN_FLAGS to reject typos. */
export const VALUE_FLAGS = new Set([
  "mode", "rerank", "type", "tag", "relevance", "status", "limit",
  "max-tokens", "title", "tags", "stamp", "path", "root", "name",
]);

const KNOWN_FLAGS = new Set<string>([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);

/**
 * Parse the argv remainder (everything after the command word) into positional
 * args and flags. Boolean flags never consume the next argument. An unknown
 * `--flag` is a usage error, unless `validate` is false (module commands parse
 * their own flags and pass the raw args through untouched).
 */
export function parseArgs(
  rest: string[],
  validate = true
): { args: string[]; flags: Flags } {
  const args: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (validate && key && !KNOWN_FLAGS.has(key)) {
        throw new UsageError(`Unknown flag: --${key}`);
      }
      const next = rest[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(arg);
    }
  }

  return { args, flags };
}

/** Output mode: JSON unless stdout is a TTY; `--json`/`--human` force it. */
export function computeJson(argv: string[]): boolean {
  if (argv.includes("--json")) return true;
  if (argv.includes("--human")) return false;
  return !(process.stdout.isTTY ?? false);
}

/**
 * Emit `data` as JSON (pretty) in JSON mode, else run `human`. Falls back to
 * JSON when no human formatter is supplied — the reference behaviour.
 */
export function emit(json: boolean, data: unknown, human?: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (human) {
    human();
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

/** Today's date as YYYY-MM-DD (UTC), matching the frontmatter date convention. */
export function today(): string {
  return new Date().toISOString().split("T")[0];
}

/** Embedding dimensions for the configured provider, or the core default. */
export function embeddingDims(embeddings?: EmbeddingProvider): number {
  return embeddings?.dimensions ?? EMBEDDING_DIMENSIONS;
}

/**
 * Open the brain database read-only, refusing (usage error) when it does not
 * exist yet — the read commands cannot operate without an index.
 */
export function openReadonlyDb(brain: BrainContext): Database {
  if (!existsSync(brain.dbPath)) {
    throw new UsageError("Database not found. Run `brain index` first.");
  }
  return openDatabase(brain.dbPath, { readonly: true });
}

/** Open (creating if needed) the brain database read-write. */
export function openWritableDb(brain: BrainContext, dims = EMBEDDING_DIMENSIONS): Database {
  return openDatabase(brain.dbPath, { embeddingDimensions: dims });
}
