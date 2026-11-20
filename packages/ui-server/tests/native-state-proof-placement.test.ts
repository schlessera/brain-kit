/** Run the native probe on real separate filesystems, with an artifact bind alias in its mount evidence. */
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { proveStateModuleBoundaries } from "../../../scripts/native-proof/state-module-boundaries.js";
import { operationalStateEvidence } from "../src/brain/operational-state.js";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";

test("native state probe keeps private input outside the aliased artifact tree", async () => {
  const artifacts = fs.mkdtempSync(join(tmpdir(), "odysseus-proof-artifacts-"));
  const brain = fs.mkdtempSync("/dev/shm/odysseus-state-brain-");
  const table = fs.readFileSync("/proc/self/mountinfo", "utf8");
  const covering = table.trim().split("\n").map(line => line.split(" ")).filter(fields => isWithin(fields[4]!, artifacts))
    .sort((a,b) => b[4]!.length - a[4]!.length)[0]!;
  const source = join(covering[3]!, artifacts.slice(covering[4]!.length));
  const mounts = spyOn(operationalStateEvidence, "mounts").mockReturnValue(table.trimEnd() + `\n90000 1 ${covering[2]} ${source} /opt/odysseus-proof-alias rw - ext4 fixture rw\n`);
  try {
    expect(fs.statSync(brain).dev, "REAL_DISTINCT_FILESYSTEM_CONTROL").not.toBe(fs.statSync(artifacts).dev);
    const artifact = join(artifacts, "proof.json");
    await proveStateModuleBoundaries(brain, artifact);
    const receipt = JSON.parse(fs.readFileSync(artifact, "utf8"));
    expect(receipt).toMatchObject({ stateDirectoryReads: 0, stateHardlink: "EXDEV", artifactOutsideState: true });
    expect(isWithin(artifacts, receipt.privateStateRoot), "PRIVATE_PROBE_INPUT_MUST_NOT_USE_PROOF_ALIAS").toBe(false);
    expect(fs.existsSync(receipt.privateStateRoot), "PRIVATE_PROBE_INPUT_IS_CLEANED").toBe(false);
  } finally { mounts.mockRestore(); fs.rmSync(brain, { recursive: true, force: true }); fs.rmSync(artifacts, { recursive: true, force: true }); }
});
