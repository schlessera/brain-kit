import { expect, test } from "bun:test";
import { nativeJournalSteeringInputs } from "../src/brain/journal-steering.js";
import type { JournalSnapshot } from "../src/brain/journal-snapshot.js";

test("native steering follows sealed configuration references without retaining a content baseline", async () => {
  const inputs = new Map([
    ["brain.config.ts", 'import "./config/helper.ts"; throw new Error("never execute");'],
    ["config/helper.ts", 'import "./routes.json";'],
    ["config/routes.json", '{"destination":"Ithaca"}'],
    ["notes/odysseus.md", "Odysseus prepares the voyage."],
  ]);
  const snapshot: JournalSnapshot = { missing: [], entries: [...inputs].map(([path, text]) => ({ path, scope: "", kind: "file", mode: 0o600, bytes: Buffer.byteLength(text), stamp: `sealed:${path}`, ignored: false })) };
  const reads: string[] = [];
  const result = await nativeJournalSteeringInputs([snapshot], async (entry, maximum) => {
    expect(maximum).toBe(1024 * 1024); reads.push(entry.path); return Buffer.from(inputs.get(entry.path)!);
  });
  expect([...result.paths].sort(), "NATIVE_STEERING_TRANSITIVE_WITHOUT_CAS").toEqual(["brain.config.ts", "config/helper.ts", "config/routes.json"]);
  expect(result.unavailable).toEqual([]);
  expect(reads).not.toContain("notes/odysseus.md");
  expect(snapshot.entries.every(entry => entry.hash === undefined)).toBe(true);
});


test("only startup consumers seed configuration, not dependency or cloned manifests", async () => {
  const inputs = new Map([
    ["package.json", '{"name":"ithaca"}'],
    ["node_modules/a/package.json", '{"name":"incidental"}'],
    ["workspaces/odyssey-tools/package.json", '{"scripts":{"start":"bun ./start.ts"}}'],
    ["workspaces/odyssey-tools/start.ts", 'throw new Error("unused");'],
  ]);
  const snapshot: JournalSnapshot = { missing: [], entries: [...inputs].map(([path, text]) => ({ path, scope: path.startsWith("workspaces/") ? "workspaces/odyssey-tools" : "", kind: "file", mode: 0o600, bytes: Buffer.byteLength(text), stamp: `sealed:${path}`, ignored: path.startsWith("node_modules/") })) };
  const reads: string[] = [];
  const result = await nativeJournalSteeringInputs([snapshot], async entry => {
    reads.push(entry.path); return Buffer.from(inputs.get(entry.path)!);
  });
  expect([...result.paths], "CONSUMER_SEEDS_EXCLUDE_INCIDENTAL_MANIFESTS").toEqual(["package.json"]);
  expect(result.unavailable, "INCIDENTAL_DEPENDENCY_NOT_COVERAGE_NOISE").not.toContain("node_modules/a/package.json");
  expect(reads).toEqual(["package.json"]);
});


test("Bun module consumers discover nearest nested package scope without activating package scripts", async () => {
  const inputs = new Map([
    ["brain.config.ts", 'import "./config/navigator/start.ts";'],
    ["config/navigator/start.ts", 'export const route = "Ithaca";'],
    ["config/navigator/package.json", '{"type":"module","scripts":{"unused":"bun ./unused.ts"}}'],
    ["config/navigator/unused.ts", 'throw new Error("not consumed");'],
    ["config/incidental/package.json", '{"type":"module"}'],
    ["workspaces/ithaca/.pi/extensions/voyage.ts", 'import "../../navigation/start.ts";'],
    ["workspaces/ithaca/navigation/start.ts", 'export const route = "Ithaca";'],
    ["workspaces/ithaca/navigation/package.json", '{"type":"module"}'],
    ["workspaces/ithaca/incidental/package.json", '{"type":"module"}'],
  ]);
  const snapshot: JournalSnapshot = { missing: [], entries: [...inputs].map(([path, text]) => ({ path, scope: path.startsWith("workspaces/") ? "workspaces/ithaca" : "", kind: "file", mode: 0o600, bytes: Buffer.byteLength(text), stamp: `sealed:${path}`, ignored: false })) };
  // The native seed index omits incidental configuration entirely. Discovery
  // must use same-scope lookup, without depending on a full content snapshot.
  const result = await nativeJournalSteeringInputs([{missing: [], entries: snapshot.entries.filter(entry => entry.path === "brain.config.ts" || entry.path.includes(".pi/"))}], async entry => Buffer.from(inputs.get(entry.path)!), path => snapshot.entries.find(entry => entry.path === path));
  for (const path of ["config/navigator/package.json", "workspaces/ithaca/navigation/package.json"]) expect(result.paths.has(path), `CONSUMED_NESTED_PACKAGE_${path}`).toBe(true);
  for (const path of ["config/incidental/package.json", "workspaces/ithaca/incidental/package.json", "config/navigator/unused.ts"]) expect(result.paths.has(path), `UNUSED_CONFIGURATION_${path}`).toBe(false);
});
