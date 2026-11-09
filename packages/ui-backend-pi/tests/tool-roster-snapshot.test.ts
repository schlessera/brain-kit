/**
 * Characterization of the curated pi tool roster (#2517): the names, order,
 * labels, descriptions and parameter schemas `createBrainTools` returns stay
 * byte-identical to the recorded fixture. The tool definitions enter the
 * provider-facing system prefix, so any change to them is a cache break and
 * must be a reviewed diff of the fixture, never a side effect of moving code.
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { WORKER_DATA_ROOT } from "@schlessera/brain-ui-sdk/internal";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed, type BrainToolDeps } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeEmptyBrain } from "./helpers";

const FIXTURE = join(import.meta.dir, "fixtures", "pi-tool-roster.json");

const VARIANTS: Record<string, Partial<BrainToolDeps>> = {
  default: {},
  directWorkerData: { directWrites: true, shellCwd: WORKER_DATA_ROOT,
    capabilities: { location: true, activity: true, inbox: true, mask: true, policyChange: true, turnTemp: true, reference: true } },
  scratchShell: { shellCwd: "/worker/scratch", capabilities: { mask: true } },
  // The host-owned web tools (#3685) join the bridge tools; nothing else moves.
  web: { capabilities: { web: true } },
};

function roster(): string {
  const brain = makeEmptyBrain();
  try {
    const out: Record<string, unknown> = {};
    for (const [name, variant] of Object.entries(VARIANTS)) {
      const tools = createBrainTools({ brain: createBrainAccess(brain.root), turn: createTurnContext(),
        lock: toolLockFromKeyed(createKeyedLock()), ...variant });
      // One SHA-256 per tool over its full serialized definition keeps the
      // fixture small while a diff still names the tool that changed.
      out[name] = tools.map(tool => {
        const definition = JSON.stringify({ name: tool.name, label: tool.label, description: tool.description,
          parameters: tool.parameters, keys: Object.keys(tool) }).replaceAll(brain.root, "<brain>");
        return `${tool.name} ${createHash("sha256").update(definition).digest("hex")}`;
      });
    }
    return JSON.stringify(out, null, 2) + "\n";
  } finally { brain.cleanup(); }
}

test("createBrainTools returns the recorded roster, byte for byte", () => {
  const actual = roster();
  if (process.env.PI_TOOL_ROSTER_RECORD === "1") writeFileSync(FIXTURE, actual);
  expect(actual).toBe(readFileSync(FIXTURE, "utf8"));
});
