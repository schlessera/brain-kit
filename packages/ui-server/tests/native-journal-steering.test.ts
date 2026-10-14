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
