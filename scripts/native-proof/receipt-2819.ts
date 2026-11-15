/** TEMPORARY draft-feedback receipt driver for #2819 (second round); reverted before the PR is ready. Never proof.
 *
 * Repeats the real reference pool proof ten times on the fixed tree while parallel
 * CPU and IO load holds the host. Each run stops on a marker thrown right after
 * case 17's REFERENCE_ACCESS_HELD_NOT_RELEASED assertion, so ten loaded runs fit
 * the step budget; later cases are not what #2819 measures. A run counts only
 * when its output carries the marker and no REFERENCE_ assertion failed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../.."), proof = join(root, "scripts/native-proof/reference-pool.native.ts");
const started = Date.now(), deadline = started + 13 * 60_000;
const held = `    "REFERENCE_ACCESS_HELD_NOT_RELEASED").toEqual({ code: "invalid", state: "writable", access: ACCESS, read: "Telemachus returns", charged: heldBefore });\n`;
const stop = `  note("receipt-held-passed", { ownerBytes: heldBefore }); throw Error("RECEIPT_2819_STOP_AFTER_HELD");\n`;

const original = readFileSync(proof, "utf8");
if (original.split(held).length !== 2) throw Error("held assertion anchor not found exactly once");
const load = [
  ...[0, 1].map(() => Bun.spawn(["nice", "-n", "5", "sh", "-c", "while :; do :; done"], { stdout: "ignore", stderr: "ignore" })),
  Bun.spawn(["sh", "-c", `while :; do dd if=/dev/urandom of=${join(root, "tmp/receipt-2819-load.bin")} bs=1M count=256 conv=fsync status=none; done`], { stdout: "ignore", stderr: "ignore" }),
];
let passed = 0, attempted = 0;
try {
  writeFileSync(proof, original.replace(held, held + stop));
  while (attempted < 10 && Date.now() < deadline) {
    attempted++;
    const at = Date.now();
    const child = Bun.spawnSync([process.execPath, join(root, "scripts/prove-reference-pool.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const output = new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
    const reached = output.includes("RECEIPT_2819_STOP_AFTER_HELD"), failed = /error: REFERENCE_[A-Z0-9_]+/.exec(output)?.[0] ?? null;
    const ok = reached && !failed;
    if (ok) passed++;
    console.log(`RECEIPT_2819 ${JSON.stringify({ variant: "clean+load", attempt: attempted, seconds: (Date.now() - at) / 1000, reachedMarker: reached, failedAssertion: failed, passedHeld: ok })}`);
    if (!ok) console.log(output.split("\n").slice(-60).join("\n"));
  }
} finally {
  writeFileSync(proof, original);
  for (const child of load) child.kill("SIGKILL");
}
console.log(`RECEIPT_2819_SUMMARY ${JSON.stringify({ heldPassed: passed, attempted, elapsedSeconds: (Date.now() - started) / 1000 })}`);
if (passed < 10) process.exitCode = 1;
