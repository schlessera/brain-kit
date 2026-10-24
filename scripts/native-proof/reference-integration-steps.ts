/**
 * The scripted agent of the integrated reference proof (#2751): the same tool
 * calls and commands through each backend. Pi runs them in order; the Claude
 * fixture runs a turn's tool calls first and its commands in one worker after
 * them, so no command here may need a worktree a later tool call releases. A
 * step's input may read earlier results; the parent asserts on every result.
 */
import type { ReferenceToolResult } from "../../packages/ui-sdk/src/tool-contracts/reference.js";

export interface IntegrationState { repository: string; results: Record<string, unknown> }
export type IntegrationStep =
  | { kind: "tool"; tool: "reference_source" | "reference_worktree"; input: (state: IntegrationState) => Record<string, string> }
  | { kind: "bash"; command: (state: IntegrationState) => string };

export const stepKey = (turn: string, index: number) => `${turn}#${index}`;
type Ok = Extract<ReferenceToolResult, { ok: true }>;
function result(state: IntegrationState, turn: string, index: number): Ok {
  const value = state.results[stepKey(turn, index)] as ReferenceToolResult | undefined;
  if (!value?.ok) throw Error(`Integration step ${stepKey(turn, index)} has no successful result: ${JSON.stringify(value)}`);
  return value;
}
export const sourcePath = (state: IntegrationState, turn: string, index: number) => {
  const value = result(state, turn, index);
  if (!("source" in value) || !value.source.path) throw Error(`Integration step ${stepKey(turn, index)} named no worker source path`);
  return value.source.path;
};
export const worktree = (state: IntegrationState, turn: string, index: number) => {
  const value = result(state, turn, index);
  if (!("worktree" in value)) throw Error(`Integration step ${stepKey(turn, index)} named no worktree`);
  return value.worktree;
};
const held = (state: IntegrationState, turn: string, index: number) => {
  const path = worktree(state, turn, index).path;
  if (!path) throw Error(`Integration step ${stepKey(turn, index)} named no worker worktree path`);
  return path;
};
const source = (): IntegrationStep => ({ kind: "tool", tool: "reference_source", input: state => ({ repository: state.repository, revision: "main" }) });
const action = (name: "access" | "renew" | "release", turn: string, index: number): IntegrationStep =>
  ({ kind: "tool", tool: "reference_worktree", input: state => ({ action: name, worktreeId: worktree(state, turn, index).id }) });
const request: IntegrationStep = { kind: "tool", tool: "reference_worktree", input: state => ({ action: "request", repository: state.repository, revision: "main" }) };

/** Turn prompts carry `Odysseus <key>`. */
export const INTEGRATION_STEPS: Record<string, IntegrationStep[]> = {
  // Acquire and inspect shared source, then request two worktrees; the second is released unused.
  inspects: [
    source(),
    { kind: "bash", command: state => `find ${sourcePath(state, "inspects", 0)}/odyssey -type f | wc -l; cat ${sourcePath(state, "inspects", 0)}/odyssey/book-23/line-49.md` },
    request,
    request,
    { kind: "bash", command: state => `find ${held(state, "inspects", 2)}/odyssey -type f | wc -l; cat ${held(state, "inspects", 2)}/odyssey/book-1/line-1.md` },
    action("release", "inspects", 3),
  ],
  // Source has moved to a newer commit; the worktree has not. Edit it and renew it.
  corrects: [
    action("access", "inspects", 2),
    source(),
    { kind: "bash", command: state => {
      const tree = held(state, "corrects", 0), shared = sourcePath(state, "corrects", 1);
      return `printf 'Ithaca chart, corrected by Odysseus.\\n' > ${tree}/odyssey/book-0/line-0.md && printf 'Argos waits.\\n' > ${tree}/odyssey/argos.md && echo WORKTREE_EDITED; `
        + `cat ${shared}/odyssey/harbour.md; { test -e ${tree}/odyssey/harbour.md && echo WORKTREE_MOVED || echo WORKTREE_FIXED; }; `
        // The group carries the redirect, so the shell's own refusal stays out of the output.
        + `{ { printf x > ${shared}/odyssey/raft.md; } 2>/dev/null && echo SOURCE_WRITTEN || echo SOURCE_READ_ONLY; }`;
    } },
    action("renew", "inspects", 2),
  ],
  // The remote fails: source falls back to its last commit, marked stale. Release the edited worktree.
  returns: [
    source(),
    action("release", "inspects", 2),
    { kind: "tool", tool: "reference_worktree", input: () => ({ action: "list" }) },
  ],
};
export const INTEGRATION_TURNS = ["inspects", "corrects", "returns"] as const;
