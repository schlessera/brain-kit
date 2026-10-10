/**
 * Fixture brain for `tests/hygiene-failed-check-retention.test.ts`. The case
 * ("role-divergence") was authored for the #843 canonical-conflict spike; only
 * the two documents and the conflict candidate the product test needs are kept.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { HygieneCandidate } from "../../../packages/core/src/lib/hygiene";

export const DAY = "2026-07-12";
const ANCHOR = "Odysseus | Role | navigator";
const OTHER = "Odysseus | Role | carpenter";
const SOLE_ROLE = "This is the sole assigned role for Odysseus during the raft provisioning watch at noon UTC on 2026-07-12; the assignments cannot coexist.\n";
const CANONICAL = "me/anchor.md", SECONDARY = "profiles/record.md";

/** The conflict a canonical-conflict check reports for this brain. */
export const conflict: HygieneCandidate = { category: "conflict", path: SECONDARY, evidence: ANCHOR,
  message: `${OTHER} disagrees with ${CANONICAL}: ${ANCHOR}` };

export function prepare() {
  const root = mkdtempSync(join(tmpdir(), "brain-canonical-conflict-"));
  const doc = (type: string, updated: string, body: string) => `---\ntype: ${type}\ntitle: Odysseus ${type}\nstatus: active\ncreated: 2026-05-01\nupdated: ${updated}\ntags: [voyage]\n---\n${body}\n`;
  const files: Record<string, string> = {
    "brain.config.json": JSON.stringify({ reranker: { enabled: false }, taxonomy: { types: { profile: { dir: "profiles" } }, canonical: { identity: CANONICAL, currentFocus: "" } } }),
    [CANONICAL]: doc("identity", DAY, `${ANCHOR}\n\n${SOLE_ROLE}`),
    [SECONDARY]: doc("profile", "2026-06-01", `${OTHER}\n\n${SOLE_ROLE}`),
  };
  for (const [path, raw] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), raw); }
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}
