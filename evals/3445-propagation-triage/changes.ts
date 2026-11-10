import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import type { Case } from "./mechanics";

/** Code computes changes; the model does not reconstruct them from memory. */
export function sourceChanges(c: Case) {
  const rawDay = parseFrontmatter(c.derivative.text).data.updated;
  const referenceDate = rawDay instanceof Date ? rawDay.toISOString().slice(0, 10) : String(rawDay);
  const root = mkdtempSync(join(tmpdir(), "brain-propagation-diff-"));
  try {
    return c.sources.map(s => {
      if (s.before === null) return { path: s.path, referenceDate, available: false,
        reference: "No source snapshot is available for the derivative's reference date; no diff inferred.", unifiedDiff: null };
      // Paths are authored fixture paths. Relative diff headers expose no host/scratch path.
      for (const [side, text] of [["before", s.before], ["current", s.current]] as const) {
        mkdirSync(dirname(join(root, side, s.path)), { recursive: true });
        writeFileSync(join(root, side, s.path), text);
      }
      const diff = Bun.spawnSync(["git", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-prefix",
        "--unified=3", "--", `before/${s.path}`, `current/${s.path}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (diff.exitCode !== 0 && diff.exitCode !== 1) throw new Error("Could not compute fixture source diff");
      return { path: s.path, referenceDate, available: true,
        reference: "The fixture supplies this source snapshot as the version associated with the derivative's reference date; no date-based Git inference is performed.",
        unifiedDiff: diff.stdout.toString() };
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
