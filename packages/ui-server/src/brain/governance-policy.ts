/** Process-local last-valid policy. Every admission reads data anew; no repository code runs. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";
import { checkGovernancePolicy, resolveGovernancePolicy, type EffectiveGovernancePolicy, type GovernanceCommandRuleIndices } from "@schlessera/brain-common/internal/governance-policy";

export interface TurnGovernancePolicy {
  readonly commandRuleIndices: Readonly<GovernanceCommandRuleIndices>;
  readonly outwardRuleIndices: readonly number[];
  readonly hash: string | null;
  readonly source: "policy" | "default" | "last_valid";
  readonly policy: EffectiveGovernancePolicy;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Freeze nested values so neither later loads nor consumers can change a running turn's policy. */
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createGovernancePolicyReader(brainPath: string) {
  let lastValid: { policy: EffectiveGovernancePolicy; hash: string; commandRuleIndices: GovernanceCommandRuleIndices; outwardRuleIndices: number[] } | undefined;
  return { load(): TurnGovernancePolicy {
    const checked = checkGovernancePolicy(brainPath);
    if (checked.status === "valid") {
      lastValid = { policy: freeze(checked.effective), hash: checked.content_hash!, commandRuleIndices: freeze(checked.commandRuleIndices!), outwardRuleIndices: freeze(checked.outwardRuleIndices!) };
      return freeze({ ...lastValid, source: "policy" as const, errors: [], warnings: [...checked.warnings] });
    }
    if (checked.status === "missing") {
      // Removing the optional file is an outside-turn edit selecting defaults;
      // an invalid edit retains the last valid file, not an inferred new policy.
      return freeze({ commandRuleIndices: { deny: [], confirm: [] }, outwardRuleIndices: [], policy: resolveGovernancePolicy({ schema_version: 1 }), hash: null, source: "default" as const, errors: [], warnings: [] });
    }
    return freeze({ commandRuleIndices: lastValid?.commandRuleIndices ?? { deny: [], confirm: [] }, outwardRuleIndices: lastValid?.outwardRuleIndices ?? [], policy: lastValid?.policy ?? resolveGovernancePolicy({ schema_version: 1 }),
      hash: lastValid?.hash ?? null, source: lastValid ? "last_valid" as const : "default" as const, errors: [...checked.errors], warnings: [] });
  } };
}

const readers = new Map<string, ReturnType<typeof createGovernancePolicyReader>>();
/**
 * The process-local reader for a brain, shared by every admission path:
 * hosted and autonomous turns keep one last-valid policy, so an invalid edit
 * cannot drop an autonomous turn's provider masks (#2691).
 */
export function governancePolicyReaderFor(brainPath: string): ReturnType<typeof createGovernancePolicyReader> {
  // One brain has one history, however its path is spelled.
  let key = resolve(brainPath);
  try { key = realpathSync(key); } catch { /* a missing brain keeps its resolved spelling */ }
  let reader = readers.get(key);
  // The reader reads the canonical path too, so no later alias change moves it.
  if (!reader) { reader = createGovernancePolicyReader(key); readers.set(key, reader); }
  return reader;
}

/** Literal recursive-folder selectors only; this is topology planning, never a provider admission verdict. */
export function providerFolderRoots(policy: Pick<EffectiveGovernancePolicy, "providers">): string[] {
  const roots = new Set<string>();
  for (const rule of policy.providers) for (const pattern of rule.paths) {
    if (!pattern.endsWith("/**")) continue;
    const root = pattern.slice(0, -3);
    if (root && !/[*?[\]{}()!]/u.test(root)) roots.add(root);
  }
  return [...roots].sort();
}

/**
 * The folders every governed writer retains while provider folders exist: the
 * literal provider roots and the disposable index directory. A restricted
 * turn's private filtered index is mounted over `.brain-index/`, so no peer or
 * publication may remove or replace it either (#1668, option B).
 */
export function retainedFolderRoots(policy: Pick<EffectiveGovernancePolicy, "providers">): string[] {
  const roots = providerFolderRoots(policy);
  return roots.length ? [...new Set([...roots, INDEX_DIR])].sort() : [];
}

/**
 * Provider selectors a hosted turn cannot enforce yet: document types,
 * non-literal globs and single paths. Only literal whole-folder `folder/**`
 * selectors are masked (2026-10-16 ruling, #1668); a policy naming anything
 * else refuses turn admission rather than leaving it silently unenforced.
 */
export function unsupportedProviderSelectors(policy: Pick<EffectiveGovernancePolicy, "providers">): string[] {
  const unsupported = new Set<string>();
  for (const rule of policy.providers) {
    for (const type of rule.types ?? []) unsupported.add(`type ${type}`);
    for (const pattern of rule.paths) {
      const root = pattern.endsWith("/**") ? pattern.slice(0, -3) : "";
      if (!root || /[*?[\]{}()!]/u.test(root)) unsupported.add(pattern);
    }
  }
  return [...unsupported].sort();
}

/** Turn admission refused because the provider policy selects what hosted turns cannot mask yet. */
export class ProviderPolicyRefusedError extends Error {
  constructor(readonly selectors: readonly string[]) {
    super(`This turn cannot start: the governance policy's provider rules select ${selectors.join(", ")}, which hosted turns cannot hide yet. `
      + "Only whole-folder selectors such as `me/**` are enforced. Change those rules to whole folders, or remove them, then retry; `brain policy check` shows the policy.");
    this.name = "ProviderPolicyRefusedError";
  }
}
