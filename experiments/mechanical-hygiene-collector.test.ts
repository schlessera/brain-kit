import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectNativePhases, type NativeEvidence, type PhaseObservation } from "../scripts/evals/mechanical-hygiene/collector";
import { observeTree } from "../scripts/evals/mechanical-hygiene/observer";
import { unchangedApproval } from "../scripts/evals/mechanical-hygiene/effects";

const receipt = (): NativeEvidence => ({ model: "claude-sonnet-5-5", exitCode: 0,
  naturalStdoutEof: true, ownedChildDrained: true, overage: "reported inactive", failure: null,
  calls: [{ requestedModel: "claude-sonnet-5-5", servedModel: "claude-sonnet-5-5",
    route: "native-claude-subscription", subscriptionAuthenticated: true, status: 200,
    inputTokens: 10, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null,
    completed: true, rawUsage: { input_tokens: 10, output_tokens: 3 } }] });

for (const fault of ["unexpected-write", "empty-usage", "wrong-model", "overage", "undrained"] as const) {
  test(`actual next driver dispatch is refused after ${fault}; no provider is used`, async () => {
    const root = mkdtempSync("/tmp/mechanical-collector-");
    try {
      writeFileSync(join(root, "note.md"), "Penelope keeps the loom ready.\n");
      const original = unchangedApproval(observeTree(root)), expected = { "dry-run": original, apply: original, repeat: original };
      let calls = 0; let retainedRows: PhaseObservation[] = []; const retained: unknown[] = [];
      let caught: unknown;
      try { await collectNativePhases(root, expected, async () => {
        calls++; const value = receipt();
        if (fault === "unexpected-write") writeFileSync(join(root, "hidden.bin"), new Uint8Array([0, 255]));
        if (fault === "empty-usage") value.calls = [];
        if (fault === "wrong-model") value.calls[0].servedModel = "unapproved-model";
        if (fault === "overage") value.overage = "active";
        if (fault === "undrained") value.ownedChildDrained = false;
        return value;
      }, (rows, failure) => { retainedRows = [...rows]; retained.push({ rows: [...rows], failure }); }); }
      catch (error) { caught = error; }
      expect(calls, "bad receipt/effect must stop before the next actual driver call").toBe(1);
      expect(caught).toBeInstanceOf(Error);
      expect(retained.length).toBeGreaterThan(0);
      expect(retainedRows).toHaveLength(1);
      if (fault === "undrained") { expect(retainedRows[0].native.ownedChildDrained).toBe(false); expect(retainedRows[0].after).toBeNull(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("three accepted modeled phases exercise the state machine without claiming native transport proof", async () => {
  const root = mkdtempSync("/tmp/mechanical-control-");
  try {
    writeFileSync(join(root, "note.md"), "Nestor keeps the council record.\n");
    const original = unchangedApproval(observeTree(root)); let calls = 0;
    const rows = await collectNativePhases(root, { "dry-run": original, apply: original, repeat: original }, async () => { calls++; return receipt(); }, () => {});
    expect(rows).toHaveLength(3); expect(calls).toBe(3);
    expect(rows.every(row => row.effects?.accepted)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
