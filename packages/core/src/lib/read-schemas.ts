/**
 * Read-tool schemas and bounds with no runtime dependency on `bun:` modules,
 * so the static read definitions
 * (`@schlessera/brain/internal/read-definitions`) load under Node. The read
 * operations re-export them.
 */
import { z } from "zod";

import type { ContextCoverage } from "./context-assembler.js";
import { MAX_SCOPE_ENTRIES, MAX_SCOPE_ENTRY_LENGTH } from "./context-scope.js";

/** The hard bound on one document page: UTF-8 bytes of the compact JSON envelope. */
export const DOCUMENT_PAGE_MAX_BYTES = 30_000;

/**
 * One of `brain_context`'s scope lists as its input schema: at most
 * {@link MAX_SCOPE_ENTRIES} paths of 1 to {@link MAX_SCOPE_ENTRY_LENGTH}
 * characters. The entry rules (`scopeEntryError`) run in the assembler, so
 * every surface refuses the same entries with the same message.
 */
export const contextScopeListSchema = z.array(z.string().min(1).max(MAX_SCOPE_ENTRY_LENGTH)).max(MAX_SCOPE_ENTRIES);

/** A scoped briefing's coverage, as `brain_context` declares it in its output schema. */
export const contextCoverageSchema = z.object({
  exhaustive: z.literal(false),
  include: z.array(z.string()).nullable(),
  exclude: z.array(z.string()),
  excerpts: z.array(
    z.object({
      path: z.string(),
      lane: z.enum(["identity", "focus", "search", "related"]),
      form: z.enum(["whole", "cut", "section", "snippet", "summary"]),
      lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
    })
  ),
  omitted: z.array(z.object({ path: z.string(), reason: z.enum(["budget", "unavailable", "not_ranked", "excluded"]) })),
  omittedMore: z.number().int().min(0),
  budgetExhausted: z.boolean(),
}) satisfies z.ZodType<ContextCoverage>;

/** `brain list` and `brain_list` return this many documents when no limit is given. */
export const DEFAULT_LIST_LIMIT = 20;
/** The largest `limit` `brain list` and `brain_list` accept. */
export const MAX_LIST_LIMIT = 100;

/**
 * The one list-limit rule both surfaces apply (#1351): a whole number from 1
 * to {@link MAX_LIST_LIMIT}. Anything else is rejected, never clamped.
 * `brain_list` uses it as its input schema; `brain list` runs its parsed
 * `--limit` through it.
 */
export const listLimitSchema = z.number().int().min(1).max(MAX_LIST_LIMIT);
