/**
 * The Claude Code runtime the permission design was last measured against.
 *
 * Several comments, tests and records in this package describe what the
 * runtime does before `canUseTool` is reached — which hooks, rules and
 * built-in checks admit a tool call, and which answer beats them. Those are
 * properties of an installed CLI, not of this code, and no keyless test can
 * observe them in the chat flow. They were measured, and this is what they
 * were measured against; each of them cites this constant by name rather than
 * repeating the numbers.
 *
 * `scripts/measure-claude-runtime.ts` re-measures every one of them. When the
 * SDK moves, `tests/measured-runtime.test.ts` fails until somebody runs it
 * and updates this constant in the same PR that carries its output
 * (docs/decisions/claude-code-runtime.md, "Re-checking a measured behaviour
 * when the version moves").
 */
export const MEASURED_RUNTIME = Object.freeze({
  /** The Claude Code release, as its `init` message reports it. */
  claudeCode: "2.1.280",
  /** `@anthropic-ai/claude-agent-sdk`, which bundles that release. */
  agentSdk: "0.3.280",
  /** When `scripts/measure-claude-runtime.ts` last passed against this pair. */
  measuredOn: "2026-09-23",
});
