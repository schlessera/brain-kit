/** Process-local last-valid policy. Every admission reads data anew; no repository code runs. */
import { realpathSync } from "node:fs";
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


/**
 * The literal folder a path selector names in full, or undefined. `F/**` and
 * `F/**\/*` match the same paths under Bun.Glob, every file at any depth below
 * `F`, so either maps exactly onto the folder. Any other pattern, a single path
 * included, selects part of a folder or something else and maps onto none.
 */
function selectorFolder(pattern: string): string | undefined {
  const root = pattern.endsWith("/**/*") ? pattern.slice(0, -5) : pattern.endsWith("/**") ? pattern.slice(0, -3) : "";
  return root && !invalidFolder(root) ? root : undefined;
}

/**
 * A folder the worker launcher cannot mask: not a canonical literal
 * brain-relative path, or `.git` or the index directory, which a denied turn
 * already sees hidden and private (`providerMaskMounts`).
 */
const invalidFolder = (folder: string) => !folder || folder.startsWith("~") || /^[A-Za-z]:/u.test(folder)
  || /[\u0000-\u001f\u007f*?[\]{}()!\\]/u.test(folder) || folder.split("/").some(part => !part || part === "." || part === "..")
  || [".git", INDEX_DIR].some(reserved => folder === reserved || folder.startsWith(`${reserved}/`));

/**
 * `folders` without any folder nested inside another of them (#2718). The
 * outer folder's mask, an empty read-only tmpfs, already hides the nested
 * one, and bubblewrap cannot create a second mount point inside it. Whatever
 * judges a path against the set (retention, the private index, the hardlink
 * scan, server-tool refusals) covers a folder and everything below it, so
 * dropping the nested folder hides nothing less.
 */
function outermostFolders(folders: Iterable<string>): string[] {
  const unique = [...new Set(folders)].sort();
  return unique.filter(folder => !unique.some(outer => folder.startsWith(`${outer}/`)));
}

/** Path selectors that map exactly onto folders; topology planning, never a provider admission verdict. */
export function providerFolderRoots(policy: Pick<EffectiveGovernancePolicy, "providers">): string[] {
  const roots = new Set<string>();
  for (const rule of policy.providers) for (const pattern of rule.paths) {
    const root = selectorFolder(pattern);
    if (root) roots.add(root);
  }
  return outermostFolders(roots);
}

/** The document types provider rules select; a hosted turn translates them with the brain's taxonomy. */
export function providerTypeSelectors(policy: Pick<EffectiveGovernancePolicy, "providers">): string[] {
  return [...new Set(policy.providers.flatMap(rule => rule.types ?? []))].sort();
}

/**
 * The folders every governed writer retains while provider folders exist: the
 * provider roots, any folders a type selector translated to (#2694) and the
 * disposable index directory. A restricted turn's private filtered index is
 * mounted over `.brain-index/`, so no peer or publication may remove or
 * replace it either (#1668, option B).
 */
export function retainedFolderRoots(policy: Pick<EffectiveGovernancePolicy, "providers">, typeFolders: readonly string[] = []): string[] {
  const roots = outermostFolders([...providerFolderRoots(policy), ...typeFolders]);
  return roots.length ? [...new Set([...roots, INDEX_DIR])].sort() : [];
}

/**
 * Path selectors a hosted turn cannot enforce: non-literal globs, single
 * paths and `.git` or index-directory folders. Only selectors that map exactly onto folders are masked (2026-10-16
 * and 2026-10-23 rulings, #1668 and #2694); a policy naming anything else
 * refuses turn admission rather than leaving it silently unenforced. Type
 * selectors are judged against the taxonomy by `translateProviderTypes`.
 */
export function unsupportedProviderSelectors(policy: Pick<EffectiveGovernancePolicy, "providers">): string[] {
  const unsupported = new Set<string>();
  for (const rule of policy.providers) for (const pattern of rule.paths) if (!selectorFolder(pattern)) unsupported.add(pattern);
  return [...unsupported].sort();
}

/** The part of the effective taxonomy that decides a type's folders (`brain config check --json`). */
export interface ProviderTaxonomy {
  /** Each type's normalized `match` prefixes (default `[dir]`), each ending in `/`. */
  readonly types: Readonly<Record<string, { readonly prefixes: readonly string[] }>>;
  /** The type every path outside all prefixes falls back to. */
  readonly inbox: string;
}

const folderOf = (prefix: string) => prefix.replace(/\/$/u, "");

/**
 * A document type maps exactly onto folders when its taxonomy prefixes are
 * literal folders that no other type's prefix nests inside, and it is not the
 * inbox type, which also covers every path outside all prefixes. Within those
 * folders longest-prefix inference gives no other type, so masking them hides
 * exactly the type's territory. A Markdown document declares its type in
 * frontmatter, so the turn also checks that no document of the type lies
 * outside them (`strayTypedDocuments`); this function judges only the
 * taxonomy. Every type it cannot translate is refused by name, with why.
 */
export function translateProviderTypes(types: readonly string[], taxonomy: ProviderTaxonomy): { folders: Record<string, string[]>; refused: string[] } {
  const folders: Record<string, string[]> = {}, refused: string[] = [];
  for (const type of types) {
    const spec = Object.hasOwn(taxonomy.types, type) ? taxonomy.types[type] : undefined;
    const roots = spec?.prefixes.map(folderOf) ?? [];
    const nested = Object.entries(taxonomy.types).flatMap(([other, { prefixes }]) => other === type ? []
      : prefixes.map(folderOf).filter(folder => roots.some(root => folder === root || folder.startsWith(`${root}/`))).map(folder => `${other} (${folder})`));
    if (!spec) refused.push(`type ${type} (not a type this brain defines)`);
    else if (type === taxonomy.inbox) refused.push(`type ${type} (the inbox type, which also covers every path outside the other types' folders)`);
    else if (!roots.length) refused.push(`type ${type} (it has no folder)`);
    else if (roots.some(invalidFolder)) refused.push(`type ${type} (its folders are not literal folders a turn can hide)`);
    else if (nested.length) refused.push(`type ${type} (its folder holds type ${nested.join(", type ")})`);
    else folders[type] = [...new Set(roots)].sort();
  }
  return { folders, refused };
}

/**
 * The folders a hosted turn masks: path selectors that map onto folders and
 * the folders its type selectors translated to, each nested folder dropped
 * for its ancestor. The same set feeds retention, the masks, the private
 * index, the hardlink scan and every server-side refusal for the turn.
 */
export function providerMaskedFolders(policy: Pick<EffectiveGovernancePolicy, "providers">, typeFolders: Readonly<Record<string, readonly string[]>> = {}): string[] {
  return outermostFolders([...providerFolderRoots(policy), ...Object.values(typeFolders).flat()]);
}

/**
 * The folders a hosted turn masks for its proven recipient (#2695): those of
 * every provider rule that does not allow it, each nested folder dropped for
 * its ancestor. Matching rules intersect their allowlists, so a folder that a
 * denying rule selects stays masked even where another rule allows the
 * recipient, and an allowed folder keeps a denied folder inside it masked.
 * An unproven recipient (`undefined`) is allowed nothing, so every provider
 * folder is masked, as `providerMaskedFolders`. The same set feeds the masks,
 * the private index, the hardlink scan and every server-side refusal.
 */
export function providerDeniedFolders(policy: Pick<EffectiveGovernancePolicy, "providers">, typeFolders: Readonly<Record<string, readonly string[]>>,
  recipient: string | undefined): string[] {
  if (recipient === undefined) return providerMaskedFolders(policy, typeFolders);
  return outermostFolders(policy.providers.filter(rule => !rule.allow.includes(recipient)).flatMap(rule => [
    ...rule.paths.map(selectorFolder).filter((root): root is string => root !== undefined),
    ...(rule.types ?? []).flatMap(type => typeFolders[type] ?? []),
  ]));
}

/** What an admitted turn's recipient saw of the provider folders (#2695). */
export interface ProviderExposure {
  readonly recipient: string;
  /** Every provider folder of the turn's policy. */
  readonly visible: readonly string[];
  /** The folders still masked from it; everything else in `visible` was shown. */
  readonly hidden: readonly string[];
}

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** Whether any part of an exposure's provider folders was shown to its recipient. */
export function exposedAnything(exposure: Pick<ProviderExposure, "visible" | "hidden">): boolean {
  return exposure.visible.some(folder => !exposure.hidden.some(hidden => within(folder, hidden)));
}

/**
 * The earlier exposures a turn masking `denied` conflicts with: a denied
 * folder overlaps a provider folder an earlier turn showed, and was not
 * itself hidden from that turn. Provider history keeps what earlier turns
 * read, so this turn's recipient would receive it (#2695, ruling 2).
 */
export function exposureConflicts(exposures: readonly ProviderExposure[], denied: readonly string[]): { folder: string; recipient: string }[] {
  const conflicts = new Map<string, { folder: string; recipient: string }>();
  for (const exposure of exposures) for (const folder of denied) {
    if (exposure.hidden.some(hidden => within(folder, hidden))) continue;
    const shown = exposure.visible.find(visible => within(folder, visible) || within(visible, folder));
    if (shown) conflicts.set(`${folder}\0${exposure.recipient}`, { folder, recipient: exposure.recipient });
  }
  return [...conflicts.values()].sort((a, b) => a.folder.localeCompare(b.folder) || a.recipient.localeCompare(b.recipient));
}

// The writer gate plans retention when it is acquired, before a turn can run
// the worker that reads the taxonomy. It reuses the folders the last admission
// under the same policy version translated, so peers acquired meanwhile retain
// them too. A stale entry only retains an extra folder; admission still
// refuses a peer lacking what it actually masks.
const lastTypeFolders = new Map<string, { hash: string | null; folders: readonly string[] }>();
const brainKey = (brainPath: string) => { try { return realpathSync(brainPath); } catch { return brainPath; } };
export function rememberProviderTypeFolders(brainPath: string, hash: string | null, folders: readonly string[]): void {
  lastTypeFolders.set(brainKey(brainPath), { hash, folders: Object.freeze([...folders].sort()) });
}
export function rememberedProviderTypeFolders(brainPath: string, hash: string | null): readonly string[] {
  const entry = lastTypeFolders.get(brainKey(brainPath));
  return entry && entry.hash === hash ? entry.folders : [];
}

/**
 * Turn admission refused because earlier turns of the conversation showed
 * provider folders to a recipient, and this turn's recipient may not see
 * them: the provider history would carry them there (#2695, ruling 2).
 */
export class ProviderRecipientRefusedError extends Error {
  constructor(readonly conflicts: readonly { folder: string; recipient: string }[], readonly recipient: string | undefined) {
    const shown = conflicts.map(conflict => `\`${conflict.folder}/\` to ${conflict.recipient}`);
    const listed = `${shown.slice(0, 3).join(", ")}${shown.length > 3 ? ` and ${shown.length - 3} more` : ""}`;
    super(`This turn cannot start: earlier turns of this conversation showed ${listed}, and the governance policy's provider rules do not let `
      + `${recipient === undefined ? "this turn's unproven recipient" : `this turn's recipient, ${recipient},`} see ${conflicts.length === 1 ? "it" : "them"}. `
      + "The conversation's history would carry it there. Continue on a profile that reaches the same recipient, or start a new conversation.");
    this.name = "ProviderRecipientRefusedError";
  }
}

/**
 * Turn admission refused because the provider policy selects what hosted turns
 * cannot mask. `selectors` names what refused: selectors, or the hardlinks
 * that would expose a masked file under another name (#2700).
 */
export class ProviderPolicyRefusedError extends Error {
  constructor(readonly selectors: readonly string[], message?: string) {
    super(message ?? `This turn cannot start: the governance policy's provider rules select ${selectors.join(", ")}, which hosted turns cannot hide. `
      + "Only whole-folder selectors such as `me/**`, and document types that map exactly onto folders, are enforced. "
      + "Change those rules to whole folders, or remove them, then retry; `brain policy check` shows the policy.");
    this.name = "ProviderPolicyRefusedError";
  }
  /** A hidden folder's file is also named outside the masks; the turn could read it there. */
  static hardlinks(links: readonly { path: string; masked: string }[]): ProviderPolicyRefusedError {
    const named = links.map(link => `${link.path} is a hardlink to ${link.masked}`);
    const listed = `${named.slice(0, 3).join("; ")}${named.length > 3 ? `; and ${named.length - 3} more` : ""}`;
    return new ProviderPolicyRefusedError(named, `This turn cannot start: ${listed}, which the governance policy's provider rules hide from hosted turns. `
      + "A folder mask hides names, not the file itself, so the turn could read it through the other name. "
      + "Remove those hardlinks (a copy outside the folder is not hidden either), then retry.");
  }
}
