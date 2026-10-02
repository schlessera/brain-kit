import { Range, inc, satisfies, valid } from "semver";

/** @experimental A host's full SemVer minima for one backend's reported identities. */
export interface BackendVersionRequirements {
  sdk?: string;
  runtime?: string;
}

/** @experimental An original compatibility declaration, retained with its owner. */
export interface VersionRequirement {
  owner: string;
  declaration: string;
  kind: "range" | "minimum";
}

/** @experimental Context for a compatibility check of one actual executable or SDK. */
export interface VersionRequirementCheck {
  identity: string;
  version: string | null;
  requirements: readonly VersionRequirement[];
  phase: string;
  action: string;
  unknownReason?: string;
}

/** @experimental Validate a full SemVer minimum without coercion. */
export function validateVersionMinimum(value: unknown, owner: string, identity: string): string {
  if (typeof value !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) || !valid(value)) {
    throw new Error(`Invalid ${owner} minimum for ${identity}: ${JSON.stringify(value)}. Supply a full ASCII SemVer version, such as 1.2.3.`);
  }
  return value;
}

function parseRequirement(requirement: VersionRequirement, identity: string): Range {
  const { owner, declaration, kind } = requirement;
  if (kind === "minimum") {
    validateVersionMinimum(declaration, owner, identity);
    return new Range(`>=${declaration}`);
  }
  if (kind !== "range" || typeof declaration !== "string" || !declaration.trim() || /[^\x20-\x7e]/.test(declaration)) {
    throw new Error(`Invalid ${owner} range for ${identity}: ${JSON.stringify(declaration)}.`);
  }
  try {
    return new Range(declaration, { loose: false });
  } catch {
    throw new Error(`Invalid ${owner} range for ${identity}: ${JSON.stringify(declaration)}.`);
  }
}

function hasCommonVersion(ranges: readonly Range[]): boolean {
  // Each OR branch is an interval. A nonempty intersection starts at an
  // exact/inclusive bound, just above an exclusive lower bound, at the next
  // stable version, or at an opted-in prerelease tuple's -0. Check those
  // witnesses against EVERY original range. Combining comparator strings
  // would incorrectly share prerelease opt-ins between owners, while pairwise
  // `intersects` is insufficient for three or more unions.
  const candidates = new Set<string>(["0.0.0"]);
  for (const range of ranges) {
    for (const branch of range.set) {
      for (const comparator of branch) {
        const version = comparator.semver;
        if (typeof version !== "object") continue; // the unbounded comparator
        candidates.add(version.version);
        const tuple = `${version.major}.${version.minor}.${version.patch}`;
        candidates.add(tuple);
        if (version.prerelease.length) {
          candidates.add(`${tuple}-0`);
          if (comparator.operator === ">") candidates.add(`${version.version}.0`);
        } else if (comparator.operator === ">") {
          for (const release of ["patch", "minor", "major"] as const) {
            const next = inc(version, release);
            if (next) candidates.add(next);
          }
        }
      }
    }
  }
  return [...candidates].some(version => valid(version) && ranges.every(range => satisfies(version, range)));
}

/** @experimental Verify every original range and minimum, preserving OR and prerelease semantics. */
export function assertVersionRequirements(check: VersionRequirementCheck): void {
  if (check.requirements.length === 0) return;
  const declarations = check.requirements.map(requirement => `${requirement.owner} ${requirement.kind} ${JSON.stringify(requirement.declaration)}`).join("; ");
  const context = `${check.identity} during ${check.phase}; detected ${check.version === null ? "unknown" : JSON.stringify(check.version)}; requirements: ${declarations}. ${check.action}`;
  let ranges: Range[];
  try {
    ranges = check.requirements.map(requirement => parseRequirement(requirement, check.identity));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${context}`);
  }
  if (!hasCommonVersion(ranges)) throw new Error(`No version satisfies all requirements for ${context}`);
  try {
    validateVersionMinimum(check.version, "detected version", check.identity);
  } catch {
    throw new Error(`Version is unknown for ${context}${check.unknownReason ? ` Reason: ${check.unknownReason}.` : ""}`);
  }
  if (!ranges.every(range => satisfies(check.version!, range))) throw new Error(`Version is incompatible for ${context}`);
}
