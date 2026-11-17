/**
 * What every curated tool factory shares within one `createBrainTools` call
 * (#2517): the turn-bound lock, repository containment and the same-turn
 * read receipts that later writes use as their base.
 */
import { createHash } from "node:crypto";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { NativeFileVersions, nativeFileVersion } from "@schlessera/brain-ui-sdk/internal";

import type { BrainAccess } from "./brain-access.js";
import type { BrainToolDeps, ToolLock } from "./tools.js";
import type { TurnContext } from "./turn-context.js";

export const MAX_READ_BYTES = 100_000;
export const MAX_OUTPUT_BYTES = 30_000;

/**
 * Name of the document update tool. Auto-allowed by DEFAULT_PI_ALLOWED_TOOLS, and gated on one
 * input shape (`status: "archived"`) by the permission gate — the two must
 * agree, so they read the same constant.
 */
export const PI_BRAIN_UPDATE_TOOL_NAME = "brain_update";

/** Result helper: pi tools return content parts + arbitrary details. */
export function textResult(text: string, details: unknown = null) {
  return { content: [{ type: "text" as const, text }], details };
}

export function clip(text: string, max = MAX_OUTPUT_BYTES): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} bytes]`;
}

export interface BrainToolKit {
  deps: BrainToolDeps;
  brain: BrainAccess;
  turn: TurnContext;
  /** `deps.lock`, admitted under the current turn's signal, priority and yield. */
  lock: ToolLock;
  /** The absolute path of a repo-relative one; throws when it escapes the repository. */
  resolveOrThrow(rel: string): string;
  /** Remembers the whole-document hash of `raw` as `path`'s base; returns it. */
  rememberBase(path: string, raw: string): string;
  /** Remembers `hash` as `path`'s base for this turn's writes; returns it. */
  rememberHash(path: string, hash: string): string;
  /** Refuses a direct write whose file changed since this roster observed it. */
  assertDirectBase(abs: string): void;
  /** Same-turn read receipts, per bridge: no read receipt crosses turns. */
  bases: WeakMap<BackendBridge, Map<string, string>>;
}

export function createBrainToolKit(deps: BrainToolDeps): BrainToolKit {
  const { brain, turn } = deps;
  const lock: ToolLock = {
    withKey: (key, body) => {
      const pending = turn.pendingMutations;
      const work = deps.lock.withKey(key, body, {
        signal: turn.signal ?? undefined,
        priority: turn.autonomous ? "autonomous" : "interactive",
        onYield: turn.autonomous?.onYield,
        yieldAfterMs: turn.autonomous?.yieldAfterMs,
        timeoutMs: 30_000,
      });
      pending?.add(work);
      void work.then(() => pending?.delete(work), () => pending?.delete(work));
      return work;
    },
  };

  const resolveOrThrow = (rel: string): string => {
    const abs = brain.resolveInRepo(rel);
    if (!abs) {
      throw new Error(
        `Path "${rel}" escapes the brain repository and was refused.`
      );
    }
    return abs;
  };

  const bases = new WeakMap<BackendBridge, Map<string, string>>();
  const directBases = new NativeFileVersions();
  const rememberBase = (path: string, raw: string): string =>
    rememberHash(path, createHash("sha256").update(raw, "utf8").digest("hex"));
  // The receipt is always a whole-document hash: a paged brain_read_base
  // remembers the server's hash, never one recomputed from its page.
  const rememberHash = (path: string, hash: string): string => {
    // No storage: the in-memory base is immediate and nothing is persisted.
    if (deps.directWrites) void directBases.remember(resolveOrThrow(path), hash);
    if (turn.bridge?.applyBrain) {
      let entries = bases.get(turn.bridge);
      if (!entries) { entries = new Map(); bases.set(turn.bridge, entries); }
      entries.set(path, hash);
    }
    return hash;
  };
  const assertDirectBase = (abs: string): void => {
    if (!deps.directWrites || !directBases.hasObservation(abs)) return;
    const refusal = directBases.check(abs, nativeFileVersion(abs));
    if (refusal) throw new Error(refusal);
  };
  return { deps, brain, turn, lock, resolveOrThrow, rememberBase, rememberHash, assertDirectBase, bases };
}
