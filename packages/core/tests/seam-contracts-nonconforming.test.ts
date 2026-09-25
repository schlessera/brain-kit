/**
 * The published seam contract suites (#342) can fail: each is run against a
 * conforming in-memory fake, which must pass every case, and against fakes
 * that each break one promise, which must fail exactly the case named for it.
 * A suite that passed everything would be no evidence for the built-ins that
 * pass it in seam-contracts.test.ts and agent-runner-contracts.test.ts.
 *
 * The suites register into a small collector here rather than into bun:test,
 * so a failing case is an observed result, not a red run.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  runAgentRunnerContract,
  runCompletionProviderContract,
  runEmbeddingProviderContract,
  runSkillEmitterContract,
  TOOL_EVENT_SEEN_FILE,
  type ContractTestPrimitives,
} from "@schlessera/brain/testing";

import type {
  AgentRunner,
  CompletionProvider,
  EmbeddingProvider,
  SkillEmitter,
} from "../src/lib/seams";

/** Register a suite into a collector, run every case, and name the ones that threw. */
async function failingCases(
  register: (primitives: ContractTestPrimitives) => void
): Promise<{ ran: number; failed: string[] }> {
  const cases: { name: string; fn: () => void | Promise<void> }[] = [];
  register({
    describe: (_name, fn) => fn(),
    test: (name, fn) => void cases.push({ name, fn }),
    expect: expect as unknown as ContractTestPrimitives["expect"],
  });
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.fn();
    } catch {
      failed.push(c.name);
    }
  }
  return { ran: cases.length, failed };
}

// ---------------------------------------------------------------------------
// EmbeddingProvider
// ---------------------------------------------------------------------------

const DIMS = 4;
const vector = (width = DIMS) => new Float32Array(width).fill(0.5);

function embeddings(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    id: "fake:embeddings",
    dimensions: DIMS,
    embed: async (texts) => texts.map(() => vector()),
    embedQuery: async (_text, opts) => {
      opts?.signal?.throwIfAborted();
      return vector();
    },
    embedImage: async () => vector(),
    embedPdf: async () => vector(),
    ...overrides,
  };
}

/** A query that waits for its signal, and rejects when it aborts. */
const cancellableHang = (_text: string, opts?: { signal?: AbortSignal }) =>
  new Promise<Float32Array>((_, reject) =>
    opts?.signal?.addEventListener("abort", () => reject(opts.signal!.reason), { once: true })
  );

describe("EmbeddingProvider contract suite", () => {
  test("a conforming provider passes every case", async () => {
    const result = await failingCases((p) =>
      runEmbeddingProviderContract(
        {
          name: "fake",
          provider: () => embeddings(),
          hanging: () => embeddings({ embedQuery: cancellableHang }),
        },
        p
      )
    );
    expect(result).toEqual({ ran: 9, failed: [] });
  });

  test("a conforming provider without multimodal methods passes every case", async () => {
    const result = await failingCases((p) =>
      runEmbeddingProviderContract(
        { name: "fake", provider: () => embeddings({ embedImage: undefined, embedPdf: undefined }) },
        p
      )
    );
    expect(result).toEqual({ ran: 7, failed: [] });
  });

  test("vectors narrower than dimensions fail the embed case", async () => {
    const narrow = embeddings({ embed: async (texts) => texts.map(() => vector(DIMS - 1)) });
    const result = await failingCases((p) =>
      runEmbeddingProviderContract({ name: "narrow", provider: () => narrow }, p)
    );
    expect(result.failed).toEqual(["embed returns one dimensions-wide vector per text"]);
  });

  test("a hanging provider that drops the forwarded signal fails the cancellation case", async () => {
    const result = await failingCases((p) =>
      runEmbeddingProviderContract(
        {
          name: "deaf",
          provider: () => embeddings(),
          hanging: () => embeddings({ embedQuery: () => new Promise<Float32Array>(() => {}) }),
        },
        p
      )
    );
    expect(result.failed).toEqual([
      "a forwarded signal rejects the pending embedQuery promptly, early or late",
    ]);
  }, 15_000);

  /** A query that ignores its signal and rejects on a clock of its own. */
  const rejectsAfter = (ms: number) => () =>
    embeddings({
      embedQuery: () =>
        new Promise<Float32Array>((_, reject) => setTimeout(() => reject(new Error("gave up")), ms)),
    });

  for (const [ms, failing] of [
    [40, "a query whose signal stays live keeps waiting on its runtime"],
    [300, "a query whose signal stays live keeps waiting on its runtime"],
    [1_500, "a forwarded signal rejects the pending embedQuery promptly, early or late"],
  ] as const) {
    test(`a query that rejects on its own at ${ms}ms, not on the abort, fails a cancellation case`, async () => {
      const result = await failingCases((p) =>
        runEmbeddingProviderContract(
          { name: "impatient", provider: () => embeddings(), hanging: rejectsAfter(ms) },
          p
        )
      );
      expect(result.failed).toEqual([failing]);
    }, 15_000);
  }
});

// ---------------------------------------------------------------------------
// CompletionProvider
// ---------------------------------------------------------------------------

function completions(
  vision: boolean,
  overrides: Partial<CompletionProvider> = {}
): (text: string) => CompletionProvider {
  return (text) => ({
    id: "fake:completions",
    capabilities: { vision },
    complete: async () => text,
    ...overrides,
  });
}

describe("CompletionProvider contract suite", () => {
  test("conforming providers, with and without vision, pass every case", async () => {
    for (const vision of [true, false]) {
      const result = await failingCases((p) =>
        runCompletionProviderContract({ name: "fake", answering: completions(vision) }, p)
      );
      expect({ vision, ...result }).toEqual({ vision, ran: 6, failed: [] });
    }
  });

  test("a vision flag that is not a boolean fails the identity case", async () => {
    const answering = (text: string) => ({
      ...completions(true)(text),
      capabilities: { vision: "yes" as unknown as boolean },
    });
    const result = await failingCases((p) =>
      runCompletionProviderContract({ name: "stringly", answering }, p)
    );
    expect(result.failed).toEqual(["id is a string and capabilities.vision a boolean"]);
  });

  test("a provider that rejects image parts fails the additive-parts case", async () => {
    const answering = (text: string) =>
      completions(false, {
        complete: async (req) => {
          if (req.parts?.some((part) => part.kind !== "text")) throw new Error("no images here");
          return text;
        },
      })(text);
    const result = await failingCases((p) =>
      runCompletionProviderContract({ name: "text-only", answering }, p)
    );
    expect(result.failed).toEqual(["parts are additive: text, image and PDF parts never fail a request"]);
  });
});

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

/** The fake agent's go-ahead: resolves once the suite has seen the tool event. */
async function toolEventSeen(cwd: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (existsSync(join(cwd, TOOL_EVENT_SEEN_FILE))) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the tool event never reached the caller");
}

const echoRunner = (overrides: Partial<AgentRunner> = {}): AgentRunner => ({
  id: "fake",
  capabilities: { streaming: true, skills: false },
  run: async (prompt, { cwd }) => {
    await toolEventSeen(cwd);
    return `${cwd}\n${prompt}`;
  },
  runStreaming: async (prompt, { cwd, onEvent }) => {
    onEvent({ kind: "tool", label: "Read: notes/voyages.md" });
    await toolEventSeen(cwd);
    return `${cwd}\n${prompt}`;
  },
  ...overrides,
});

/** Holds the agent's events back and delivers them all once it has finished. */
const bufferingRunner = (): AgentRunner =>
  echoRunner({
    runStreaming: async (prompt, { cwd, onEvent }) => {
      const held = [{ kind: "tool" as const, label: "Read: notes/voyages.md" }];
      try {
        await toolEventSeen(cwd);
      } finally {
        for (const event of held) onEvent(event);
      }
      return `${cwd}\n${prompt}`;
    },
  });

const timingOut = (): AgentRunner =>
  echoRunner({
    run: (_prompt, { timeoutMs }) =>
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs)),
  });

describe("AgentRunner contract suite", () => {
  test("a conforming runner passes every case", async () => {
    const result = await failingCases((p) =>
      runAgentRunnerContract({ name: "fake", echoing: () => echoRunner(), hanging: timingOut }, p)
    );
    expect(result).toEqual({ ran: 6, failed: [] });
  });

  test("streaming declared without runStreaming fails the agreement case", async () => {
    const result = await failingCases((p) =>
      runAgentRunnerContract(
        { name: "claims", echoing: () => echoRunner({ runStreaming: undefined }), hanging: timingOut },
        p
      )
    );
    expect(result.failed).toEqual(["capabilities.streaming agrees with whether runStreaming exists"]);
  });

  test("a runner that ignores cwd fails the run case", async () => {
    const result = await failingCases((p) =>
      runAgentRunnerContract(
        {
          name: "elsewhere",
          echoing: () =>
            echoRunner({
              capabilities: { streaming: false, skills: false },
              run: async (prompt) => `${process.cwd()}\n${prompt}`,
              runStreaming: undefined,
            }),
          hanging: timingOut,
        },
        p
      )
    );
    expect(result.failed).toEqual(["run executes the agent in cwd on the prompt and resolves to its final text"]);
  });

  test("a runner that ignores timeoutMs fails the timeout case", async () => {
    const result = await failingCases((p) =>
      runAgentRunnerContract(
        {
          name: "deaf",
          echoing: () => echoRunner(),
          hanging: () => echoRunner({ run: () => new Promise<string>(() => {}) }),
        },
        p
      )
    );
    expect(result.failed).toEqual([
      "run honours timeoutMs: a run that never finishes rejects once its deadline passes",
      "run honours timeoutMs: a longer deadline keeps the run going past the shorter one",
    ]);
  }, 20_000);

  for (const [ms, failing] of [
    [600, "run honours timeoutMs: a longer deadline keeps the run going past the shorter one"],
    [1_200, "run honours timeoutMs: a longer deadline keeps the run going past the shorter one"],
    [3_000, "run honours timeoutMs: a run that never finishes rejects once its deadline passes"],
  ] as const) {
    test(`a runner on a fixed ${ms}ms deadline of its own fails a timeout case`, async () => {
      const fixed = (): AgentRunner =>
        echoRunner({
          run: () => new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
        });
      const result = await failingCases((p) =>
        runAgentRunnerContract({ name: "fixed", echoing: () => echoRunner(), hanging: fixed }, p)
      );
      expect(result.failed).toEqual([failing]);
    }, 20_000);
  }

  test("a runner that holds tool events back until the end fails the streaming case", async () => {
    const result = await failingCases((p) =>
      runAgentRunnerContract({ name: "buffering", echoing: bufferingRunner, hanging: timingOut }, p)
    );
    expect(result.failed).toEqual([
      "runStreaming, when present, resolves to the final text and surfaces tool activity as it happens",
    ]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// SkillEmitter
// ---------------------------------------------------------------------------

/** Writes `.fake/<name>.txt` per skill; `prune` removes the ones no longer listed. */
function fileEmitter(opts: { prune: boolean; dir?: string }): SkillEmitter {
  const dir = opts.dir ?? ".fake";
  return {
    agent: "fake",
    emit(skills, repoRoot) {
      const out = join(repoRoot, dir);
      mkdirSync(out, { recursive: true });
      const written: string[] = [];
      const removed: string[] = [];
      for (const skill of skills) {
        const rel = `${dir}/${skill.name}.txt`;
        if (existsSync(join(repoRoot, rel))) continue;
        writeFileSync(join(repoRoot, rel), skill.description);
        written.push(rel);
      }
      if (opts.prune) {
        const want = new Set(skills.map((s) => `${s.name}.txt`));
        for (const entry of readdirSync(out)) {
          if (want.has(entry) || !entry.endsWith(".txt")) continue;
          rmSync(join(out, entry));
          removed.push(`${dir}/${entry}`);
        }
      }
      return { written, removed };
    },
  };
}

describe("SkillEmitter contract suite", () => {
  test("a conforming emitter passes every case", async () => {
    const result = await failingCases((p) =>
      runSkillEmitterContract({ name: "fake", emitter: () => fileEmitter({ prune: true }) }, p)
    );
    expect(result).toEqual({ ran: 6, failed: [] });
  });

  test("a conforming emitter that reports a whole directory passes every case", async () => {
    // Writes the same files, but reports the directory rather than each file.
    const directory = (): SkillEmitter => {
      const inner = fileEmitter({ prune: true });
      return {
        agent: "fake-dir",
        emit(skills, repoRoot) {
          const { removed } = inner.emit(skills, repoRoot);
          return { written: [".fake"], removed };
        },
      };
    };
    const result = await failingCases((p) =>
      runSkillEmitterContract({ name: "directory", emitter: directory }, p)
    );
    expect(result).toEqual({ ran: 6, failed: [] });
  });

  test("an emitter that empties its directory on an unchanged re-emit fails the re-emit case", async () => {
    const destructive = (): SkillEmitter => {
      const inner = fileEmitter({ prune: true });
      let last = -1;
      return {
        agent: "fake-dir",
        emit(skills, repoRoot) {
          const unchanged = skills.length === last;
          last = skills.length;
          const { removed } = inner.emit(skills, repoRoot);
          if (unchanged) {
            for (const entry of readdirSync(join(repoRoot, ".fake"))) rmSync(join(repoRoot, ".fake", entry));
          }
          return { written: [".fake"], removed };
        },
      };
    };
    const result = await failingCases((p) =>
      runSkillEmitterContract({ name: "destructive", emitter: destructive }, p)
    );
    expect(result.failed).toEqual(["re-emitting an unchanged list removes nothing and keeps the layout"]);
  });

  test("an emitter that never prunes fails the dropped-skill case", async () => {
    const result = await failingCases((p) =>
      runSkillEmitterContract({ name: "hoarder", emitter: () => fileEmitter({ prune: false }) }, p)
    );
    expect(result.failed).toEqual(["a skill dropped from the list leaves the layout"]);
  });

  test("an emitter that writes into the canonical home fails the canonical-home case", async () => {
    const result = await failingCases((p) =>
      runSkillEmitterContract(
        { name: "squatter", emitter: () => fileEmitter({ prune: true, dir: ".agents/skills" }) },
        p
      )
    );
    expect(result.failed).toEqual(["the canonical home is read, never written"]);
  });
});
