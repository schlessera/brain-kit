/**
 * Temp brains for the `brain compute` CLI and MCP contract tests. The config
 * passes test providers by value: `ithaca-host` is the local-process provider
 * (its sandboxes are directories, so a job survives across CLI processes;
 * `ithaca-long` allows a longer lease than that provider can hold),
 * `pylos-memory` is the in-memory provider (one process only, for MCP), and
 * `sparta-keyed` names a credential variable that is never set. State and
 * sandbox directories are test-owned and passed through the environment.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cleanup, makeTempBrain } from "../../cli-harness";

const HELPERS = resolve(import.meta.dir);

export interface ComputeBrain {
  root: string;
  state: string;
  work: string;
  env: Record<string, string>;
  dispose(): void;
}

export const COMPUTE_CONFIG = `
import { defineConfig } from "@schlessera/brain";
import { localProcessCompute } from ${JSON.stringify(join(HELPERS, "local-process-provider.ts"))};
import { memoryCompute } from ${JSON.stringify(join(HELPERS, "memory-provider.ts"))};

const local = localProcessCompute(process.env.ODYSSEUS_WORK_ROOT!);
const memory = memoryCompute({ capabilities: { retain: false } });

export default defineConfig({
  profile: { name: "Odysseus" },
  compute: {
    providers: {
      "ithaca-host": { provider: local.provider, lease: { maxSeconds: 600 }, maxConcurrent: 4 },
      "ithaca-long": { provider: local.provider, lease: { maxSeconds: 200000 } },
      "pylos-memory": { provider: memory.provider, lease: { maxSeconds: 600 }, maxConcurrent: 4 },
      "sparta-keyed": { provider: memory.provider, apiKeyEnv: "ODYSSEUS_SPARTA_COMPUTE_KEY", lease: { maxSeconds: 600 } },
      "argos-unknown": { provider: "trireme", lease: { maxSeconds: 600 } },
    },
  },
});
`;

/**
 * The local-process provider with two faults, for the CLI's signal and
 * cleanup paths: `ithaca-gated` holds staging until `<work>/open-stage`
 * exists (at most 20 s), and `ithaca-leaky` never confirms a release, with a
 * reason carrying terminal escape sequences.
 */
export const FAULT_CONFIG = `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@schlessera/brain";
import { localProcessCompute } from ${JSON.stringify(join(HELPERS, "local-process-provider.ts"))};

const work = process.env.ODYSSEUS_WORK_ROOT!;
const local = localProcessCompute(work);
const gated = {
  ...local.provider,
  async stage(ref, source, ctx) {
    for (let i = 0; i < 400 && !existsSync(join(work, "open-stage")); i++) await Bun.sleep(50);
    return local.provider.stage(ref, source, ctx);
  },
};
const leaky = {
  ...local.provider,
  async release() {
    return { kind: "failed", reason: "the harbour \\u001b]0;Scylla\\u0007is closed \\u001b[2J" };
  },
};

export default defineConfig({
  profile: { name: "Odysseus" },
  compute: {
    providers: {
      "ithaca-gated": { provider: gated, lease: { maxSeconds: 600 }, maxConcurrent: 4 },
      "ithaca-leaky": { provider: leaky, lease: { maxSeconds: 600 }, maxConcurrent: 4 },
    },
  },
});
`;

/** A brain with a few Odysseus notes; `config` is the brain.config.ts body, or none at all. */
export function computeBrain(config: string | null = COMPUTE_CONFIG): ComputeBrain {
  const root = makeTempBrain({ empty: true });
  const base = realpathSync(mkdtempSync(join(tmpdir(), "brain-compute-cli-")));
  const state = join(base, "state");
  const work = join(base, "work");
  mkdirSync(state);
  mkdirSync(work);
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes/raft.md"), "---\ntype: note\n---\n# The raft\nTwenty trees, felled on Ogygia.\n");
  writeFileSync(join(root, "notes/route.md"), "---\ntype: note\n---\n# Route home\nKeep the Bear on the left hand.\n");
  if (config !== null) writeFileSync(join(root, "brain.config.ts"), config);
  else writeFileSync(join(root, "brain.config.json"), JSON.stringify({ profile: { name: "Odysseus" } }));
  return {
    root,
    state,
    work,
    env: { BRAIN_COMPUTE_STATE_DIR: state, ODYSSEUS_WORK_ROOT: work },
    dispose() {
      cleanup(root);
      cleanup(base);
    },
  };
}
