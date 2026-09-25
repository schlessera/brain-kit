/**
 * `@schlessera/brain/testing` — contract suites for the four core seams.
 *
 * One suite per seam: the promises each seam's page under docs/extending/
 * makes, as tests a provider outside this repository can run against its own
 * implementation. The same suites run every built-in in this repository
 * (packages/core/tests/seam-contracts.test.ts and
 * agent-runner-contracts.test.ts).
 *
 * Test registration and assertions are injected — pass `{ describe, test,
 * expect }` from `bun:test` — so importing this module pulls in no test
 * runner, and nothing here needs a key or the network.
 */

export type { ContractTestPrimitives } from "./primitives.js";
export {
  runEmbeddingProviderContract,
  type EmbeddingProviderContractHarness,
} from "./embeddings.js";
export {
  runCompletionProviderContract,
  type CompletionProviderContractHarness,
} from "./completions.js";
export { runAgentRunnerContract, type AgentRunnerContractHarness } from "./agent-runners.js";
export { runSkillEmitterContract, type SkillEmitterContractHarness } from "./skill-emitters.js";
