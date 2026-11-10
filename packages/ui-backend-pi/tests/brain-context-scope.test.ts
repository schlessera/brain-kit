/**
 * pi's brain_context with `include` and `exclude` (#3644), through the real
 * tool over an indexed Odysseus corpus, keyless. Pi leaves the identity and
 * current-focus slots out of every call, scoped or not; the scope then holds
 * in the search lane, its section expansion and the related neighbours. Both
 * watched files are named pipes that count every open (`openCounter`), so a
 * test proves an excluded file is never opened.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { indexAll, initContext, openDatabase } from "@schlessera/brain/internal";

import {
  FOCUS,
  FOCUS_MARKER,
  makeScopeBrain,
  openCounter,
  REGISTRY,
  REGISTRY_MARKER,
  SCOPE_QUERY,
} from "../../core/tests/helpers/context-scope-fixture";
import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { resultText } from "./helpers";

const CTX = {} as never;
let brain: ReturnType<typeof makeScopeBrain>;
let counters: Array<[string, ReturnType<typeof openCounter>]> = [];

beforeAll(async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  brain = makeScopeBrain();
  const ctx = await initContext({ root: brain.root });
  const db = openDatabase(ctx.dbPath);
  try {
    await indexAll(db, { root: brain.root, taxonomy: ctx.taxonomy, force: true, quiet: true });
  } finally {
    db.close();
  }
  counters = [FOCUS, REGISTRY].map((rel) => [rel, openCounter(brain.root, rel)]);
});

afterAll(() => {
  for (const [, counter] of counters) counter.stop();
  brain?.cleanup();
});

function contextTool(): ToolDefinition {
  const tools = createBrainTools({ brain: createBrainAccess(brain.root), turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) });
  return tools.find((tool) => tool.name === "brain_context")!;
}

const counts = async () => Promise.all(counters.map(async ([rel, counter]) => [rel, await counter.opens()] as const));

async function run(params: Record<string, unknown>) {
  const before = new Map(await counts());
  const result = await contextTool().execute("c", { query: SCOPE_QUERY, maxTokens: 12000, ...params }, undefined, undefined, CTX);
  const opened = (await counts()).filter(([rel, n]) => n > before.get(rel)!).map(([rel]) => rel);
  return { text: resultText(result), details: result.details as Record<string, unknown>, opened };
}

describe("brain_context in pi", () => {
  test("the premise: unscoped, no canonical slot, but the focus returns as a hit and is opened for its section", async () => {
    const { text, details, opened } = await run({});
    expect(text.split("\n")).not.toContain("## Current Focus");
    expect(text.split("\n")).not.toContain("## Identity");
    expect(text).toContain(`(${FOCUS})`);
    expect(opened).toContain(FOCUS);
    // Unscoped results are what they were: no coverage, the same details.
    expect(text).not.toContain("### Coverage");
    expect(details).toEqual({ query: SCOPE_QUERY });
  });

  test("exclude keeps both files unopened and out of every lane, and the result says what it covers", async () => {
    const { text, details, opened } = await run({ exclude: [FOCUS, REGISTRY] });
    expect(opened, "PI_EXCLUDED_NOT_OPENED").toEqual([]);
    for (const marker of [FOCUS_MARKER, REGISTRY_MARKER, `(${FOCUS})`, `(${REGISTRY})`]) expect(text).not.toContain(marker);
    // Pi's canonical slots stay off when scoped, too.
    expect(text.split("\n")).not.toContain("## Identity");
    expect(text).toContain("### Coverage\nScoped briefing: ranked excerpts within a budget, not an inventory of the scope.");
    const coverage = details.coverage as { exhaustive: boolean; exclude: string[]; excerpts: Array<{ path: string; lane: string }> };
    expect(coverage.exhaustive).toBe(false);
    expect(coverage.exclude).toEqual([FOCUS, REGISTRY]);
    expect(coverage.excerpts.length).toBeGreaterThan(0);
    expect(coverage.excerpts.filter((e) => e.lane !== "search" && e.lane !== "related")).toEqual([]);
  });

  test("include constrains selection and expansion, and names requested paths it left out", async () => {
    const include = ["projects/active/sail-repairs/", "health/knee-injury.md"];
    const { text, details } = await run({ include });
    const coverage = details.coverage as { excerpts: Array<{ path: string }>; omitted: Array<{ path: string; reason: string }> };
    expect(coverage.excerpts.length).toBeGreaterThan(0);
    for (const { path } of coverage.excerpts) expect(path.startsWith("projects/active/sail-repairs/"), path).toBe(true);
    expect(coverage.omitted).toContainEqual({ path: "health/knee-injury.md", reason: "not_ranked" });
    expect(text).toContain("health/knee-injury.md (not ranked)");
  });

  test("an invalid entry is refused before anything is read", async () => {
    const before = new Map(await counts());
    await expect(
      contextTool().execute("c", { query: SCOPE_QUERY, include: ["../outside.md"] }, undefined, undefined, CTX)
    ).rejects.toThrow("include:");
    const after = await counts();
    expect(after).toEqual([...before]);
  });
});
