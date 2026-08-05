/**
 * The single taxonomy resolver.
 *
 * Effective taxonomy = core built-ins ⊕ module contributions ⊕ user overrides.
 * Collisions between owners (a module redefining a core/module type, or two
 * types claiming the identical dir prefix) are hard validation errors; user
 * overrides of existing types are an intentional merge layer and allowed.
 *
 * All path-shaped questions (type→dir, path→type, staleness, anchors, asset
 * titles, exclusions, classification hints) are answered here and nowhere else.
 */

import type {
  AssetTitleRule,
  BrainConfig,
  PropagationRule,
  TypeSpec,
} from "./config.js";
import {
  CORE_TYPES,
  DEFAULT_CANONICAL,
  DEFAULT_DIR_ANCHORS,
  DEFAULT_EXCLUDE,
  DEFAULT_STALENESS,
} from "./config.js";
import type { LoadedModule } from "./module-types.js";

export type Severity = "error" | "warning" | "info";

export interface ResolvedTypeSpec extends TypeSpec {
  /** Which layer defined (or last overrode) this type. */
  owner: "core" | `module:${string}` | "user";
  /** Normalized match prefixes with trailing slash; empty = skip dir checks. */
  prefixes: string[];
}

export interface StalenessVerdict {
  days: number;
  severity: Severity;
}

interface ClassifierRule {
  type: string;
  regex: RegExp;
}

/** Core classification hints, checked after module and user hints. */
const CORE_CLASSIFIER_HINTS: Record<string, string[]> = {
  context: ["today", "this week", "right now", "currently", "this month"],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileHints(type: string, phrases: string[]): ClassifierRule {
  const body = phrases.map(escapeRegex).join("|");
  return { type, regex: new RegExp(`\\b(${body})\\b`, "i") };
}

function normalizePrefix(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

/** Glob over a directory path: `**` = any depth (incl. none), `*` = one segment. */
function dirGlobToRegex(pattern: string): RegExp {
  // A trailing "/**" also matches the bare directory itself.
  const trimmed = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  const suffix = pattern.endsWith("/**") ? "(?:/.*)?" : "";
  const parts = trimmed
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]+" : escapeRegex(part)));
  return new RegExp(`^${parts.join("")}${suffix}`);
}

export class Taxonomy {
  readonly types: Record<string, ResolvedTypeSpec>;
  readonly dirAnchors: string[];
  readonly canonical: Record<string, string>;
  readonly propagation: PropagationRule[];
  readonly assetTitleRules: AssetTitleRule[];
  readonly exclude: { dirs: string[]; files: string[]; segments: string[] };
  readonly defaultStaleness: StalenessVerdict;

  private readonly classifierRules: ClassifierRule[];
  /** [prefix, type] sorted longest-prefix-first. */
  private readonly prefixIndex: [string, string][];
  /** Staleness rules sorted longest-prefix-first. */
  private readonly stalenessRules: { prefix: string; days: number; severity: Severity }[];
  private readonly inbox: string;

  constructor(args: {
    types: Record<string, ResolvedTypeSpec>;
    dirAnchors: string[];
    canonical: Record<string, string>;
    propagation: PropagationRule[];
    assetTitleRules: AssetTitleRule[];
    classifierRules: ClassifierRule[];
    exclude: { dirs: string[]; files: string[]; segments: string[] };
    defaultStaleness: StalenessVerdict;
  }) {
    this.types = args.types;
    this.dirAnchors = args.dirAnchors;
    this.canonical = args.canonical;
    this.propagation = args.propagation;
    this.assetTitleRules = args.assetTitleRules;
    this.classifierRules = args.classifierRules;
    this.exclude = args.exclude;
    this.defaultStaleness = args.defaultStaleness;

    this.prefixIndex = Object.entries(this.types)
      .flatMap(([type, spec]) => spec.prefixes.map((p): [string, string] => [p, type]))
      .sort((a, b) => b[0].length - a[0].length);

    this.stalenessRules = Object.values(this.types)
      .filter((spec) => spec.staleDays !== undefined && spec.dir !== null)
      .map((spec) => ({
        prefix: normalizePrefix(spec.dir as string),
        days: spec.staleDays as number,
        severity: spec.staleSeverity ?? ("warning" as const),
      }))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    const inboxTypes = Object.entries(this.types).filter(([, s]) => s.inbox);
    if (inboxTypes.length === 0) {
      throw new Error(
        'Taxonomy has no inbox type — exactly one type needs `inbox: true` (core default: "note")'
      );
    }
    this.inbox = inboxTypes[0][0];
  }

  validTypes(): string[] {
    return Object.keys(this.types);
  }

  isValidType(type: string): boolean {
    return type in this.types;
  }

  /** Canonical creation directory for a type; null = any directory. */
  dirForType(type: string): string | null {
    return this.types[type]?.dir ?? null;
  }

  /**
   * Infer a type from a path via longest-prefix match over all match
   * prefixes. Falls back to the inbox type.
   */
  typeForPath(path: string): string {
    for (const [prefix, type] of this.prefixIndex) {
      if (path.startsWith(prefix)) return type;
    }
    return this.inbox;
  }

  /**
   * Accepted directory prefixes for a type, for the type/dir-mismatch audit.
   * null = dir checks are skipped for this type (dir: null, no match list).
   */
  expectedPrefixesFor(type: string): string[] | null {
    const spec = this.types[type];
    if (!spec) return null;
    return spec.prefixes.length > 0 ? spec.prefixes : null;
  }

  /** Staleness threshold for a path: longest matching explicit rule, else default. */
  stalenessFor(path: string): StalenessVerdict {
    for (const rule of this.stalenessRules) {
      if (path.startsWith(rule.prefix)) {
        return { days: rule.days, severity: rule.severity };
      }
    }
    return this.defaultStaleness;
  }

  /** Human-readable title for a binary asset path. */
  assetTitleFor(path: string): string {
    const parts = path.split("/");
    const filename = parts[parts.length - 1].replace(/\.[^.]+$/, "");
    const dir = parts.slice(0, -1).join("/");

    for (const rule of this.assetTitleRules) {
      if ("prefix" in rule) {
        if (dir.startsWith(rule.prefix)) return `${rule.label}: ${filename}`;
      } else {
        if (dirGlobToRegex(rule.pattern).test(dir)) {
          const slug = rule.slugFrom !== undefined ? parts[rule.slugFrom] : undefined;
          return slug ? `${rule.label}: ${filename} (${slug})` : `${rule.label}: ${filename}`;
        }
      }
    }

    const dirLabel = parts.length > 1 ? parts[parts.length - 2] : "asset";
    return `${dirLabel}: ${filename}`;
  }

  /** True when a relative path falls under an excluded dir, segment, or file. */
  isExcludedPath(path: string): boolean {
    if (this.exclude.files.includes(path)) return true;
    if (this.exclude.dirs.some((dir) => path.startsWith(`${dir}/`) || path === dir)) return true;
    return this.exclude.segments.some(
      (seg) => path.includes(`/${seg}/`) || path.startsWith(`${seg}/`)
    );
  }

  /** The capture-inbox type (`brain add` default). */
  inboxType(): string {
    return this.inbox;
  }

  /** Types whose documents accept title-matched appends, in definition order. */
  appendMatchTypes(): string[] {
    return Object.entries(this.types)
      .filter(([, spec]) => spec.appendMatch)
      .map(([type]) => type);
  }

  isOrphanExempt(type: string): boolean {
    return this.types[type]?.orphanExempt ?? false;
  }

  /** First classifier hint whose pattern matches, or null. */
  classify(content: string): string | null {
    for (const rule of this.classifierRules) {
      if (rule.regex.test(content)) return rule.type;
    }
    return null;
  }

  /** Well-known document path (identity, currentFocus, …); null when unset/disabled. */
  canonicalPath(key: string): string | null {
    const value = this.canonical[key];
    return value ? value : null;
  }
}

/**
 * Build the effective taxonomy from core defaults, loaded modules (config
 * order), and the user config. Throws on ownership collisions.
 */
export function buildTaxonomy(opts: {
  user?: BrainConfig | null;
  modules?: LoadedModule[];
}): Taxonomy {
  const user = opts.user ?? null;
  const modules = opts.modules ?? [];

  // --- types: core ⊕ modules (collision = error) ⊕ user (override allowed)
  const types: Record<string, ResolvedTypeSpec> = {};
  for (const [name, spec] of Object.entries(CORE_TYPES)) {
    types[name] = { ...spec, owner: "core", prefixes: [] };
  }

  for (const mod of modules) {
    for (const [name, spec] of Object.entries(mod.manifest.taxonomy?.types ?? {})) {
      const existing = types[name];
      if (existing) {
        throw new Error(
          `Taxonomy collision: module "${mod.manifest.name}" defines type "${name}" already owned by ${existing.owner}`
        );
      }
      types[name] = { ...spec, owner: `module:${mod.manifest.name}`, prefixes: [] };
    }
  }

  for (const [name, spec] of Object.entries(user?.taxonomy?.types ?? {})) {
    const existing = types[name];
    types[name] = existing
      ? { ...existing, ...spec, owner: "user", prefixes: [] }
      : { ...spec, owner: "user", prefixes: [] };
  }

  // --- normalize match prefixes + duplicate-prefix collision check
  const prefixOwner = new Map<string, string>();
  for (const [name, spec] of Object.entries(types)) {
    const raw = spec.match ?? (spec.dir !== null ? [spec.dir] : []);
    spec.prefixes = raw.map(normalizePrefix);
    for (const prefix of spec.prefixes) {
      const owner = prefixOwner.get(prefix);
      if (owner && owner !== name) {
        throw new Error(
          `Taxonomy collision: types "${owner}" and "${name}" both claim dir prefix "${prefix}"`
        );
      }
      prefixOwner.set(prefix, name);
    }
  }

  // --- classifier hints: modules (config order) → user → core defaults.
  //
  // Sources ACCUMULATE per type rather than the first one winning: a module
  // that claims `conference` must not silence the user's own conference
  // vocabulary (configuration.md promises "modules contribute theirs; yours
  // layer on top"). Rule ORDER still follows first appearance, since the
  // classifier takes the first matching rule and that ordering is what a
  // module's placement in `modules` expresses. Within a type the compiled
  // regex is an alternation, so intra-type order is irrelevant.
  const hintPhrases = new Map<string, string[]>();
  const hintOrder: string[] = [];
  const pushHints = (hints: Record<string, string[]>, origin: string) => {
    for (const [type, phrases] of Object.entries(hints)) {
      if (!(type in types)) {
        throw new Error(`${origin} declares classifierHints for unknown type "${type}"`);
      }
      if (phrases.length === 0) continue;
      let existing = hintPhrases.get(type);
      if (!existing) {
        existing = [];
        hintPhrases.set(type, existing);
        hintOrder.push(type);
      }
      for (const phrase of phrases) {
        if (!existing.includes(phrase)) existing.push(phrase);
      }
    }
  };
  for (const mod of modules) {
    pushHints(mod.manifest.taxonomy?.classifierHints ?? {}, `module "${mod.manifest.name}"`);
  }
  pushHints(user?.taxonomy?.classifierHints ?? {}, "brain.config");
  pushHints(
    Object.fromEntries(Object.entries(CORE_CLASSIFIER_HINTS).filter(([t]) => t in types)),
    "core"
  );
  const classifierRules: ClassifierRule[] = hintOrder.map((type) =>
    compileHints(type, hintPhrases.get(type)!)
  );

  // --- dir anchors: core → modules → user, deduped keeping first occurrence
  const dirAnchors = [
    ...DEFAULT_DIR_ANCHORS,
    ...modules.flatMap((m) => m.manifest.indexRules?.dirAnchors ?? []),
    ...(user?.taxonomy?.dirAnchors ?? []),
  ].filter((anchor, i, arr) => arr.indexOf(anchor) === i);

  // --- canonical: defaults ⊕ user ("" disables a key)
  const canonical: Record<string, string> = {
    ...DEFAULT_CANONICAL,
    ...(user?.taxonomy?.canonical ?? {}),
  };

  // --- propagation + asset title rules: modules then user
  const propagation = [
    ...modules.flatMap((m) => m.manifest.taxonomy?.propagation ?? []),
    ...(user?.taxonomy?.propagation ?? []),
  ];
  const assetTitleRules = [
    ...(user?.taxonomy?.assetTitleRules ?? []),
    ...modules.flatMap((m) => m.manifest.taxonomy?.assetTitleRules ?? []),
  ];

  // --- exclusions: core defaults ∪ module segments ∪ user
  const exclude = {
    dirs: [...new Set([...DEFAULT_EXCLUDE.dirs, ...(user?.exclude?.dirs ?? [])])],
    files: [...new Set([...DEFAULT_EXCLUDE.files, ...(user?.exclude?.files ?? [])])],
    segments: [
      ...new Set([
        ...DEFAULT_EXCLUDE.segments,
        ...modules.flatMap((m) => m.manifest.exclude?.segments ?? []),
        ...(user?.exclude?.segments ?? []),
      ]),
    ],
  };

  return new Taxonomy({
    types,
    dirAnchors,
    canonical,
    propagation,
    assetTitleRules,
    classifierRules,
    exclude,
    defaultStaleness: user?.taxonomy?.defaultStaleness ?? DEFAULT_STALENESS,
  });
}
