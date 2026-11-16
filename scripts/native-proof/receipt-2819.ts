/** TEMPORARY draft-feedback receipt driver for #2819; reverted before the PR is ready. Never proof.
 *
 * Runs the real reference pool proof under three source variants and then ten
 * times clean under parallel CPU and IO load, printing one RECEIPT_2819 line each:
 *  - old-aggregate+reclaim: the pre-fix aggregate comparison while an unrelated
 *    root is released and reclaimed between the readings. Expected to fail
 *    REFERENCE_ACCESS_HELD_NOT_RELEASED on `charged`.
 *  - owner+reclaim: the fixed owner-charge comparison under the same
 *    reclamation. Expected to pass.
 *  - owner+no-held-refusal: the fixed comparison with #2729's held-worktree
 *    refusal removed from the pool. Expected to fail REFERENCE_ACCESS_HELD_NOT_RELEASED.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../.."), proof = join(root, "scripts/native-proof/reference-pool.native.ts");
const pool = join(root, "packages/ui-sdk/src/server/native-reference-pool.ts");
const started = Date.now(), deadline = started + 12.5 * 60_000;

const ballast = `  const ballast = await create("staging", 8 * MIB); fill(join(ballast.path!, "ballast.bin"), 4 * MIB);\n`;
const reclaim = `  expect(["deleting", "deleted", "reclaimed"], "RECEIPT_BALLAST_RELEASED").toContain((await release(ballast.id)).state);
  for (let wait = 0; wait < 600; wait++) { sync(); await status(); const left = (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.find(item => item.id === ballast.id);
    if (!left || left.state === "reclaimed") { note("receipt-ballast", { waited: wait }); break; } await Bun.sleep(100); }
`;
const fixedBefore = `  const heldBefore = await heldCharge();\n`;
const fixedAfter = `  const heldAfter = await heldCharge();\n`;
const fixedBlock = `  const heldAfter = await heldCharge();
  expect({ code: heldRefusal.code, state: heldRecord?.state, access: heldRecord?.access, read: await ask("read"), charged: heldAfter },
    "REFERENCE_ACCESS_HELD_NOT_RELEASED").toEqual({ code: "invalid", state: "writable", access: ACCESS, read: "Telemachus returns", charged: heldBefore });
`;
const oldBlock = `  expect({ code: heldRefusal.code, state: heldRecord?.state, access: heldRecord?.access, read: await ask("read"), charged: (await charged()).chargedBytes },
    "REFERENCE_ACCESS_HELD_NOT_RELEASED").toEqual({ code: "invalid", state: "writable", access: ACCESS, read: "Telemachus returns", charged: heldAggregate.chargedBytes });
`;
const refusal = `    if (intent.state === "writable" && intent.access)
      throw new NativeBrainManagerError("invalid", "This worktree is held by an access generation; park it before releasing it.");
`;

type Edit = { file: string; from: string; to: string };
const variants: { name: string; edits: Edit[]; expectFailure: boolean }[] = [
  { name: "old-aggregate+reclaim", expectFailure: true, edits: [
    { file: proof, from: fixedBefore, to: ballast + `  const heldAggregate = await charged();\n` + fixedBefore },
    { file: proof, from: fixedBlock, to: reclaim + oldBlock }] },
  { name: "owner+reclaim", expectFailure: false, edits: [
    { file: proof, from: fixedBefore, to: ballast + fixedBefore },
    { file: proof, from: fixedAfter, to: reclaim + fixedAfter }] },
  { name: "owner+no-held-refusal", expectFailure: true, edits: [{ file: pool, from: refusal, to: "" }] },
];

function run(name: string): { code: number; output: string; seconds: number } {
  const at = Date.now();
  const child = Bun.spawnSync([process.execPath, join(root, "scripts/prove-reference-pool.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
  const seconds = (Date.now() - at) / 1000;
  console.log(`=== ${name}: exit ${child.exitCode} in ${seconds}s`);
  return { code: child.exitCode ?? -1, output, seconds };
}
function excerpt(output: string, marker: string) {
  const lines = output.split("\n"), at = lines.findIndex(line => line.includes(marker));
  return at < 0 ? lines.slice(-40).join("\n") : lines.slice(Math.max(0, at - 5), at + 30).join("\n");
}

let mismatches = 0;
for (const variant of variants) {
  const originals = new Map<string, string>();
  for (const edit of variant.edits) {
    const text = originals.get(edit.file) ?? readFileSync(edit.file, "utf8");
    if (!originals.has(edit.file)) originals.set(edit.file, text);
    const current = readFileSync(edit.file, "utf8");
    if (current.split(edit.from).length !== 2) throw Error(`${variant.name}: anchor not found exactly once in ${edit.file}`);
    writeFileSync(edit.file, current.replace(edit.from, edit.to));
  }
  try {
    const result = run(variant.name);
    const named = result.output.includes("REFERENCE_ACCESS_HELD_NOT_RELEASED");
    const ok = variant.expectFailure ? result.code !== 0 && named : result.code === 0;
    if (!ok) mismatches++;
    console.log(`RECEIPT_2819 ${JSON.stringify({ variant: variant.name, exit: result.code, seconds: result.seconds, namedAssertion: named, asExpected: ok })}`);
    if (variant.expectFailure || !ok) console.log(excerpt(result.output, "REFERENCE_ACCESS_HELD_NOT_RELEASED"));
  } finally { for (const [file, text] of originals) writeFileSync(file, text); }
}

// Ten clean runs while parallel load holds the host, as in the reported failures.
const load = [
  ...[0, 1].map(() => Bun.spawn(["nice", "-n", "5", "sh", "-c", "while :; do :; done"], { stdout: "ignore", stderr: "ignore" })),
  Bun.spawn(["sh", "-c", `while :; do dd if=/dev/urandom of=${join(root, "tmp/receipt-2819-load.bin")} bs=1M count=256 conv=fsync status=none; done`], { stdout: "ignore", stderr: "ignore" }),
];
let clean = 0, attempted = 0;
try {
  while (attempted < 10 && Date.now() < deadline) {
    attempted++;
    const result = run(`clean+load ${attempted}`);
    if (result.code === 0) clean++; else { mismatches++; console.log(excerpt(result.output, "REFERENCE_")); }
    console.log(`RECEIPT_2819 ${JSON.stringify({ variant: "clean+load", attempt: attempted, exit: result.code, seconds: result.seconds })}`);
  }
} finally { for (const child of load) child.kill("SIGKILL"); }
console.log(`RECEIPT_2819_SUMMARY ${JSON.stringify({ cleanPassed: clean, cleanAttempted: attempted, mismatches, elapsedSeconds: (Date.now() - started) / 1000 })}`);
if (mismatches || clean < 10) process.exitCode = 1;
