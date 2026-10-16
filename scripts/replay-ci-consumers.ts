/** Offline replay of the audited #1741–#2071 PR snapshot; no provider/network calls. */
import { resolve } from "node:path";
import { planChecks, rootConsumers, workspaces } from "./ci-plan";
interface ReplaySnapshot { cutoff: string; order: string; prs: { number: number; changed: string[]; mergeCommit: string }[]; }

export function replayConsumers(root: string, snapshot: ReplaySnapshot) {
  if (snapshot.prs.length !== 100 || new Set(snapshot.prs.map(pr => pr.number)).size !== 100 ||
      snapshot.prs.some(pr => !/^[a-f0-9]{40}$/.test(pr.mergeCommit) || !pr.changed.length)) throw new Error("Expected 100 immutable merged PR diffs");
  const packages = workspaces(root);
  const rows = snapshot.prs.map(({ number, changed, mergeCommit }) => {
    const diff = Bun.spawnSync(["git", "diff", "--name-only", "--no-renames", "-z", `${mergeCommit}^`, mergeCommit], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const actual = diff.stdout.toString().split("\0").filter(Boolean).sort();
    if (diff.exitCode || JSON.stringify(actual) !== JSON.stringify([...changed].sort())) throw new Error(`PR #${number}: snapshot does not match immutable merge diff`);
    const before = planChecks(changed, packages, root, false);
    const after = planChecks(changed, packages, root);
    const hard = changed.filter(path => ["bun.lock", "package.json", ".changeset/config.json"].includes(path) || path.startsWith(".github/workflows/"));
    const unknown = changed.filter(path => !/^(?:packages|template|api-report|docs|scripts|tests|experiments|website)\//.test(path) && !/\.(?:md|mdx|txt)$/.test(path) && !path.startsWith(".changeset/") && path !== "LICENSE");
    return { number, mergeCommit, beforeGlobal: before.global, afterGlobal: after.global,
      unitFiles: after.unitTests, local: after.local,
      reason: after.global ? hard.length ? `Global policy inputs: ${hard.join(", ")}` : unknown.length ? `Unknown roots: ${unknown.join(", ")}` :
        rootConsumers(root, changed.filter(path => /^(?:scripts|tests|experiments|website)\//.test(path))).reason ?? "Unknown package ownership" : undefined };
  });
  return { cutoff: snapshot.cutoff, order: snapshot.order, count: rows.length,
    beforeGlobal: rows.filter(row => row.beforeGlobal).length,
    afterGlobal: rows.filter(row => row.afterGlobal).length, rows };
}
if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("usage: bun scripts/replay-ci-consumers.ts <snapshot.json>");
  console.log(JSON.stringify(replayConsumers(resolve(import.meta.dir, ".."), await Bun.file(process.argv[2]!).json()), null, 2));
}
