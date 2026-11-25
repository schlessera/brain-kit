/**
 * The gog transport for the Google operations (#4205, plan
 * [`docs/plans/google-workspace.md`](../../../../../docs/plans/google-workspace.md) §8, §11):
 * the pinned binary, argv discipline, the allow-listed environment, the
 * runner and the strict read codecs.
 *
 * Internal to brain-kit and Bun only: reached through
 * `@schlessera/brain-common/internal/google-gog`, with no compatibility
 * promise. The host (#4206, #4207) and the standalone CLI (#4208) build one
 * transport per account with {@link createGogTransport} and call
 * `execute(operation, input)`; nothing above that line sees argv or gog's
 * JSON. The pure operation definitions stay in
 * `@schlessera/brain-common/internal/google-operations`, which never imports
 * this module.
 */
export {
  createGogTransport, GOG_CONCURRENCY, GOG_READ_OPERATIONS, isTargetIndependentGogFailure,
  type GogAvailability, type GogBinary, type GogLogEvent, type GogReadOperation, type GogReadResults, type GogResult, type GogTransport,
  type GogTransportOptions,
} from "./transport.js";
export {
  GOG_OPERATION_INPUTS, isGogAccountAlias, type GogOperationInput,
} from "./argv.js";
export type { GogDraftRead } from "./codecs.js";
export { GOG_ENVIRONMENT_NAMES, gogEnvironment, type GogEnvironment, type GogEnvironmentConfig, type GogEnvironmentName } from "./environment.js";
export { GOG_EXIT_CODES, type GogExitClass } from "./errors.js";
export { GOG_PIN_REFUSALS, GOG_PIN_TRANSIENT_REFUSALS, verifyGogBinary, type GogBinaryIdentity, type GogPinRefusal, type GogPinResult } from "./pin.js";
export { GOG_PINS, GOG_PLATFORMS, gogPlatform, type GogPin, type GogPlatform } from "./pins.js";
