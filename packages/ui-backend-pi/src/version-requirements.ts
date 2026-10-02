import { assertLoadedSdk } from "@schlessera/brain-ui-sdk/internal";
import { assertVersionRequirements, type BackendVersionRequirements } from "@schlessera/brain-ui-sdk/server";

const OWNER = "@schlessera/brain-backend-pi";
const PRIMARY = "@earendil-works/pi-coding-agent";
const CORE = "@earendil-works/pi-agent-core";
const AI = "@earendil-works/pi-ai";

/** Check backend imports AND copies used inside the primary SDK's dependency graph. */
export function assertPiSdks(requirements: BackendVersionRequirements | undefined, phase: string) {
  if (requirements?.runtime !== undefined) {
    assertVersionRequirements({ identity: `${OWNER} runtime`, version: null,
      requirements: [{ owner: "host versionRequirements.runtime", kind: "minimum", declaration: requirements.runtime }],
      phase, unknownReason: "Pi is an in-process SDK and has no separate runtime identity",
      action: "Remove the Pi runtime requirement; declare an SDK minimum for pi-coding-agent instead." });
  }
  const check = (name: string, entry: string, minimum?: string) => assertLoadedSdk({ owner: OWNER,
    ownerManifest: new URL("../package.json", import.meta.url), name, entry, phase,
    ...(minimum !== undefined ? { minimum } : {}) });
  const primaryEntry = import.meta.resolve(PRIMARY);
  const primary = check(PRIMARY, primaryEntry, requirements?.sdk);
  check(CORE, import.meta.resolve(CORE));
  check(AI, import.meta.resolve(`${AI}/providers/all`));
  check(AI, import.meta.resolve(`${AI}/compat`));
  // A nested copy below the coding-agent/core is the one their runtime imports
  // load. A compatible hoisted copy at our own import site cannot vouch for it.
  const coreEntry = import.meta.resolve(CORE, primaryEntry);
  check(CORE, coreEntry);
  check(AI, import.meta.resolve(AI, primaryEntry));
  check(AI, import.meta.resolve(AI, coreEntry));
  return primary;
}
