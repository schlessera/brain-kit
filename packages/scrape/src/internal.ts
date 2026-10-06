/**
 * First-party implementation sharing for brain-kit packages. Not a supported
 * API: no compatibility guarantee, and consumers must use the same lockstep
 * version. See docs/decisions/public-export-boundary.md.
 */
export { Semaphore } from "./browser/semaphore.js";
export { DEFAULT_USER_AGENT } from "./config/env.js";
export { hostOf } from "./politeness/rate-limit.js";
