import { describe, expect, test } from "bun:test";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import type { ListedDocument } from "@schlessera/brain/queries";
import type { BrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { resultText } from "./helpers";

const CENTER = "notes/odysseus.md";

// The existing collaborator seam isolates registration/forwarding from traversal.
// Sentinels are deliberately nonempty so envelopes and details cannot pass vacuously.
describe("registered Pi adapters forward parameters without a transport", () => {
  test("each listing filter and boundary reaches BrainAccess unchanged", async () => {
    const calls: unknown[] = [];
    const rows: ListedDocument[] = [{ path: CENTER, title: "Odysseus", type: "note", status: null, relevance: null, tags: null }];
    const brain = { list: async (args: unknown) => { calls.push(args); return rows; } } as unknown as BrainAccess;
    const registered = createBrainTools({ brain, turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) });
    const tool = registered.find(t => t.name === "brain_list")!;
    const filters = [{}, { type: "project" }, { tag: "Ithaca" }, { status: "draft" }, { status: "archived" }, { relevance: "secondary" }, { type: "note", tag: "Ithaca", status: "active", relevance: "primary" }, { limit: 0 }, { limit: 1000 }];
    for (const args of filters) {
      const result = await tool.execute("adapter", args as never, undefined, undefined, {} as never);
      expect(calls.at(-1)).toEqual(args);
      expect(JSON.parse(resultText(result))).toEqual({ documents: rows });
      expect(result.details).toEqual({ count: 1 });
    }
  });

  test("graph forwards path/depth and normalizes only unknown or absent directions", async () => {
    const calls: unknown[] = [];
    const value = { edges: [{ source: CENTER, target: "Unknown Harbour", resolved: false }], nodes: [{ path: CENTER, title: "Odysseus", type: "note", summary: null, updated: null }] };
    const brain = { graph: async (args: unknown) => { calls.push(args); return value; } } as unknown as BrainAccess;
    const registered = createBrainTools({ brain, turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) });
    const tool = registered.find(t => t.name === "brain_graph")!;
    for (const direction of ["outgoing", "incoming", "both", "unknown", undefined]) {
      for (const depth of [undefined, -1, 1, 2, 3, 4, 9]) {
        const result = await tool.execute("adapter", { path: CENTER, depth, direction } as never, undefined, undefined, {} as never);
        expect(calls.at(-1)).toEqual({ path: CENTER, depth, direction: direction === "incoming" || direction === "outgoing" ? direction : "both" });
        expect(JSON.parse(resultText(result))).toEqual(value);
        expect(result.details).toEqual({ count: 1 });
      }
    }
  });
});
