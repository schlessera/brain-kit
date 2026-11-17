// #2701: bubblewrap reports the worker's PID before it builds the sandbox's
// mount table. A `/proc/<pid>/mountinfo` opened against a root that the next
// `pivot_root` detaches lists nothing, because the kernel skips every mount
// unreachable from the root captured at open. That empty read is "not ready
// yet", never a qualified view. A malformed record still refuses at once.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkerProtection, verifyWorkerFolderMounts } from "../src/server/worker-protection.js";
import { workerStep } from "../src/server/worker-steps.js";

const roots: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A brain whose `group/private` folder is retained, qualified for this process as the "worker". */
function qualifiedBrain() {
  const brain = realpathSync(mkdtempSync(join(tmpdir(), "mountinfo-read-"))); roots.push(brain);
  mkdirSync(join(brain, "group/private"), { recursive: true });
  const { protection, reason } = resolveWorkerProtection(brain, { paths: [], folderPaths: ["group/private"] });
  expect(reason, "FIXTURE_FOLDER_QUALIFIED").toBeUndefined();
  const complete = ["21 1 0:31 / / rw - tmpfs tmpfs rw", `22 21 0:32 / ${brain}/group rw - ext4 ext4 rw`,
    `23 22 0:33 / ${brain}/group/private rw - ext4 ext4 rw`].join("\n") + "\n";
  return { brain, protection, retained: ["group/private"], complete };
}

/** Feed the worker's mountinfo reads from a script; the last entry repeats. */
function scriptMountinfo(pid: number, reads: readonly string[]) {
  const original = fs.readFileSync;
  let served = 0;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) !== `/proc/${pid}/mountinfo`) return (original as (...a: unknown[]) => unknown)(...args);
    const text = reads[Math.min(served++, reads.length - 1)]!;
    return args[1] === undefined ? Buffer.from(text) : text;
  }) as typeof fs.readFileSync);
  restores.push(() => spy.mockRestore());
  return { served: () => served };
}

test("an empty mountinfo read during sandbox setup waits for the complete table and then qualifies", () => {
  const { brain, protection, retained, complete } = qualifiedBrain();
  const reads = scriptMountinfo(process.pid, ["", "", complete]);
  expect(() => verifyWorkerFolderMounts(brain, protection, retained, process.pid, Date.now() + 5_000),
    "EMPTY_SETUP_READ_IS_NOT_A_MALFORMED_TABLE").not.toThrow();
  expect(reads.served(), "QUALIFIED_ONLY_FROM_THE_COMPLETE_TABLE").toBe(3);
});

test("a mount table that stays empty refuses at the deadline with its read diagnostics", () => {
  const { brain, protection, retained } = qualifiedBrain();
  scriptMountinfo(process.pid, [""]);
  let refusal: unknown;
  try { verifyWorkerFolderMounts(brain, protection, retained, process.pid, Date.now() + 50); } catch (error) { refusal = error; }
  const message = String(refusal);
  expect(message, "EMPTY_TABLE_NEVER_QUALIFIES").toContain("provider folder topology could not be qualified before payload start: invalid worker mount record");
  expect(message, "DIAGNOSTIC_NAMES_EMPTY_READ_AND_CALL_SITE").toContain("empty read at readiness");
  expect(message, "DIAGNOSTIC_NAMES_BYTE_LENGTH").toContain("0 bytes");
  expect(message, "DIAGNOSTIC_NAMES_WORKER_STATE").toMatch(/worker state [A-Za-z] start \d+/);
  expect(message, "DIAGNOSTIC_NAMES_ELAPSED").toMatch(/after \d+ms/);
});

test("a malformed mount record refuses at once, without waiting for the deadline", () => {
  const { brain, protection, retained, complete } = qualifiedBrain();
  const reads = scriptMountinfo(process.pid, [`${complete}24 23\n`]);
  const started = Date.now();
  let refusal: unknown;
  try { verifyWorkerFolderMounts(brain, protection, retained, process.pid, Date.now() + 5_000); } catch (error) { refusal = error; }
  expect(String(refusal), "MALFORMED_TABLE_STILL_REFUSES").toContain("invalid worker mount record: malformed record 4 at readiness");
  expect(String(refusal), "MALFORMED_DIAGNOSTIC_NAMES_BYTES").toContain(`${Buffer.byteLength(`${complete}24 23\n`)} bytes`);
  expect(reads.served(), "MALFORMED_TABLE_IS_NOT_RETRIED").toBe(1);
  expect(Date.now() - started, "MALFORMED_TABLE_REFUSES_BEFORE_THE_DEADLINE").toBeLessThan(2_000);
});

test("an empty read at the brain-view check refuses and names that call site", () => {
  const { brain, protection, retained, complete } = qualifiedBrain();
  scriptMountinfo(process.pid, [complete, ""]);
  let closed = 0;
  const open = () => fs.openSync(brain, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY), close = () => { closed++; };
  let refusal: unknown;
  try {
    verifyWorkerFolderMounts(brain, protection, retained, process.pid, Date.now() + 5_000, undefined,
      { open: () => workerStep(open, async () => open()), close: () => workerStep(close, async () => close()) });
  } catch (error) { refusal = error; }
  expect(String(refusal), "BRAIN_VIEW_EMPTY_READ_REFUSES").toContain("invalid worker mount record: empty read at brain-view");
  expect(closed, "REFUSED_BRAIN_VIEW_IS_RETURNED").toBe(1);
});
