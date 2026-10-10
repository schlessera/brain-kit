/**
 * @schlessera/brain-ui-sdk — the chat-UI contract layer.
 *
 * - ./protocol : the wire protocol (compatibility contract)
 * - ./server   : AgentBackend / SpeechProvider seams + transcript store
 * - ./client   : tool-renderer + AsrClient registries (React peer)
 *
 * The root exports the protocol and environment descriptors; import server/client
 * submodules explicitly so server bundles never touch client code.
 */
export * from "./protocol.js";
export { ENV_VARS } from "./config/env.js";
export type { ModuleSettingsField, ModuleSettingsOption, ModuleSettingsSnapshot, ModuleSettingsFailure, ConfiguredModule, ModuleSettingsMigrationPreview } from "./module-settings.js";
