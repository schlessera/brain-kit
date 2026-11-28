/**
 * The static definitions of the brain's read tools, shared with the hosted
 * Claude bridge (#4325). A separate entry so a consumer that only registers
 * these schemas loads no database or Bun-only module: the Claude backend
 * stays importable under Node. First-party implementation sharing only: no
 * compatibility guarantee, same lockstep version
 * (docs/decisions/public-export-boundary.md).
 */
export { brainReadDefinitions, BRAIN_READ_DEFINITION_VERSION } from "./mcp-read-definitions.js";
