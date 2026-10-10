import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { observeTree } from "../scripts/evals/mechanical-hygiene/observer";
import { assessEffects, unchangedApproval } from "../scripts/evals/mechanical-hygiene/effects";

test("a hygiene directory prefix cannot approve arbitrary log bytes or an unexpected binary file", () => {
  const root = mkdtempSync("/tmp/mechanical-effects-");
  try {
    writeFileSync(join(root, "note.md"), "Penelope keeps the loom ready.\n");
    const before = observeTree(root), expected = unchangedApproval(before);
    mkdirSync(join(root, "context/hygiene"), { recursive: true });
    const log = "# Open\n\nAn authored fictional finding.\n";
    expected["context/hygiene/open.md"] = { bytesBase64: Buffer.from(log).toString("base64"), mode: 0o644, changed: true };
    writeFileSync(join(root, "context/hygiene/open.md"), log);
    expect(assessEffects(before, observeTree(root), expected).accepted).toBe(true);
    writeFileSync(join(root, "context/hygiene/open.md"), "# Open\n\nUnexpected replacement.\n");
    expect(assessEffects(before, observeTree(root), expected).problems).toContain("wrong bytes, kind or mode: context/hygiene/open.md");
    writeFileSync(join(root, "context/hygiene/open.md"), log);
    writeFileSync(join(root, "context/hygiene/hidden.bin"), new Uint8Array([0, 255, 1]));
    expect(assessEffects(before, observeTree(root), expected).problems).toContain("unapproved file: context/hygiene/hidden.bin");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unchanged exact bytes still refuse timestamp churn", () => {
  const root = mkdtempSync("/tmp/mechanical-churn-");
  try {
    writeFileSync(join(root, "note.md"), "Nestor keeps the council record.\n");
    utimesSync(join(root, "note.md"), new Date("2026-07-10"), new Date("2026-07-10"));
    const before = observeTree(root), expected = unchangedApproval(before);
    utimesSync(join(root, "note.md"), new Date("2026-07-11"), new Date("2026-07-11"));
    expect(assessEffects(before, observeTree(root), expected).problems).toContain("unchanged-file timestamp churn: note.md");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
