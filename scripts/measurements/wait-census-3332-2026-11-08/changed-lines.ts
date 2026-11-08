// Lines matching the census expression at <new> whose trimmed text does not occur
// (with at least the same multiplicity) in the same file at <old>; only files that
// matched at <old> (files new since <old> are covered whole by classify-waits.ts).
const [oldSha, newSha] = Bun.argv.slice(2);
const P = "setTimeout|Bun.sleep|waitForTimeout|sleep\\(";
const grep = (sha: string) => {
  const r = Bun.spawnSync(["git", "grep", "-n", "-E", P, sha, "--", "tests", "experiments", ":(glob)packages/*/tests/**"], { stdout: "pipe" });
  const m = new Map<string, { line: number; text: string }[]>();
  for (const raw of r.stdout.toString().trim().split("\n")) {
    const x = raw.match(/^[^:]+:([^:]+):(\d+):(.*)$/)!;
    (m.get(x[1]!) ?? m.set(x[1]!, []).get(x[1]!)!).push({ line: Number(x[2]), text: x[3]!.trim() });
  }
  return m;
};
const a = grep(oldSha!), b = grep(newSha!);
for (const [file, rows] of b) {
  const old = a.get(file); if (!old) continue;
  const bag = new Map<string, number>(); for (const o of old) bag.set(o.text, (bag.get(o.text) ?? 0) + 1);
  for (const r of rows) { const n = bag.get(r.text) ?? 0; if (n > 0) bag.set(r.text, n - 1); else console.log(`${file}\t${r.line}\t${r.text.slice(0, 200)}`); }
}
