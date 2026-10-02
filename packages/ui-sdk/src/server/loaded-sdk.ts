import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersionRequirements, type VersionRequirement } from "./version-requirements.js";

interface Manifest {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
}

// Successful metadata belongs to an immutable imported copy, never to a host
// root or a requested floor. Requirements are composed again for every caller.
const manifests = new Map<string, Manifest>();
function manifest(path: string): Manifest {
  const key = realpathSync(path);
  let value = manifests.get(key);
  if (!value) {
    value = JSON.parse(readFileSync(key, "utf8")) as Manifest;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest is not an object");
    manifests.set(key, value);
  }
  return value;
}

/** First-party sharing: read the manifest belonging to an already resolved import. */
export function loadedSdkIdentity(entry: string, name: string): { name: string; version: string } {
  const path = entry.startsWith("file:") ? fileURLToPath(entry) : entry;
  let dir = dirname(realpathSync(path));
  // dist/ entry points are allowed. Stop at the FIRST enclosing manifest:
  // neither a wrong package nor a missing copy may borrow a host's metadata.
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const data = manifest(candidate);
      if (data.name !== name) throw new Error(`expected manifest name ${JSON.stringify(name)}, found ${JSON.stringify(data.name)}`);
      return { name, version: typeof data.version === "string" ? data.version : "" };
    }
    const parent = dirname(dir);
    if (parent === dir || dir.endsWith("/node_modules")) throw new Error("loaded SDK manifest is missing");
    dir = parent;
  }
}

/** First-party sharing: enforce the owner's manifest range on its actual import. */
export function assertLoadedSdk(options: {
  owner: string;
  ownerManifest: URL;
  name: string;
  /** Resolve at the backend's import site, with the same ESM conditions. */
  entry: string;
  minimum?: string;
  phase: string;
}): { name: string; version: string } {
  const action = `Install ${options.name} within ${options.owner}'s dependency range and the host minimum, or upgrade the backend package/correct the host requirement. Preserve the imported package's manifest when bundling.`;
  const requirements: VersionRequirement[] = [];
  let identity: { name: string; version: string } | undefined;
  let unknownReason: string | undefined;
  try {
    const own = manifest(fileURLToPath(options.ownerManifest));
    if (own.name !== options.owner) throw new Error(`owning manifest name is ${JSON.stringify(own.name)}, expected ${options.owner}`);
    const declaration = own.dependencies?.[options.name];
    if (typeof declaration !== "string") throw new Error(`owning dependency declaration for ${options.name} is missing`);
    requirements.push({ owner: options.owner, kind: "range", declaration });
    identity = loadedSdkIdentity(options.entry, options.name);
  } catch (error) {
    unknownReason = error instanceof Error ? error.message : String(error);
  }
  if (options.minimum !== undefined) requirements.push({ owner: "host versionRequirements.sdk", kind: "minimum", declaration: options.minimum });
  if (!requirements.some(req => req.kind === "range")) {
    throw new Error(`${options.owner} ${options.name} during ${options.phase}; required owning dependency range unavailable; detected unknown. ${unknownReason}. ${action}`);
  }
  assertVersionRequirements({ identity: `${options.owner} SDK (${options.name})`, version: identity?.version ?? null,
    requirements, phase: options.phase, action, ...(unknownReason ? { unknownReason } : {}) });
  return identity!;
}
