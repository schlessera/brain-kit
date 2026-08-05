/**
 * @schlessera/brain-ui-sdk — the chat-UI contract layer.
 *
 * - ./protocol : the wire protocol (compatibility contract)
 * - ./server   : AgentBackend / SpeechProvider seams + transcript store
 * - ./client   : tool-renderer + AsrClient registries (React peer)
 *
 * The root export re-exports the protocol only; import the server/client
 * submodules explicitly so server bundles never touch client code.
 */
export * from "./protocol.js";
