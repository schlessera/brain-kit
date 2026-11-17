/**
 * Disposable brains, state directories and a fake clock for the compute
 * lifecycle tests. Every path is under a fresh temp directory; nothing
 * touches the user's state home. The clock starts on the corpus date.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createComputeService } from "../../../src/lib/compute/service";
import type { ComputeCaller, ComputeServiceOptions } from "../../../src/lib/compute/types";
import type { BrainConfig } from "../../../src/lib/config";

export const PENELOPE: ComputeCaller = { kind: "cli", principal: "penelope" };
export const TELEMACHUS: ComputeCaller = { kind: "mcp", principal: "telemachus" };
export const HOSTED: Extract<ComputeCaller, { kind: "hosted" }> = { kind: "hosted", principal: "odysseus", session: "s-ogygia", turn: "t-1" };

export const START = Date.parse("2026-07-12T08:00:00Z");

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function fakeClock(start = START): FakeClock {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms), set: (ms) => void (t = ms) };
}

export interface Sandbox {
  base: string;
  root: string;
  state: string;
  dispose(): void;
}

/** A brain with a few Odysseus notes, and a separate state directory beside it. */
export function sandbox(): Sandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "brain-compute-")));
  const root = join(base, "brain");
  const state = join(base, "state");
  for (const [path, text] of Object.entries({
    "notes/raft.md": "---\ntype: note\n---\n# The raft\nTwenty trees, felled on Ogygia.\n",
    "notes/route.md": "---\ntype: note\n---\n# Route home\nKeep the Bear on the left hand.\n",
    "health/sea-sickness.md": "---\ntype: health\n---\n# Sea sickness\n",
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { base, root, state, dispose: () => rmSync(base, { recursive: true, force: true }) };
}

export function jobDirs(state: string): string[] {
  const jobs = join(state, "jobs");
  return existsSync(jobs) ? readdirSync(jobs) : [];
}

export function service(box: Sandbox, compute: BrainConfig["compute"], extra: Partial<ComputeServiceOptions> = {}) {
  return createComputeService({ root: box.root, stateDir: box.state, config: { compute }, env: {}, callTimeoutMs: 2_000, ...extra });
}

/** Every file under `dir` whose bytes contain `text`. */
export function filesContaining(dir: string, text: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesContaining(path, text));
    else if (readFileSync(path).includes(text)) out.push(path);
  }
  return out;
}
