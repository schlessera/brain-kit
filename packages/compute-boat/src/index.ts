/**
 * @schlessera/brain-compute-boat — the `boat` external compute provider.
 *
 * Core loads this package only when a `compute.providers` instance names
 * `provider: "boat"`. Installing or importing it makes no request: every
 * call to Boat happens inside a provider method the host invokes with an
 * instance's context. The package maps Boat's public HTTP API onto the
 * vendor-independent ComputeProvider contract with plain `fetch`; it ships
 * no vendor SDK and imports `@schlessera/brain` for types only.
 */

import { createBoatProvider } from "./provider.js";

/** The provider core's `boat` built-in resolves to. */
export const computeProvider = createBoatProvider();

/**
 * The variable an instance without `apiKeyEnv` reads its key from. Distinct
 * from the variable Boat's own CLI reads, so a broad key exported for the CLI
 * is never picked up implicitly.
 */
export const defaultKeyEnv = "BRAIN_COMPUTE_BOAT_API_KEY";

export { BOAT_CAPABILITIES } from "./provider.js";
export { BOAT_MACHINES, boatOptionsSchema } from "./options.js";
export type { BoatOptions } from "./options.js";
