/** Native state-boundary receipt for #4301; module-store activation is absent. */
import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createOperationalStateProof } from "../../packages/ui-server/src/brain/operational-state.js";
export async function proveStateModuleBoundaries(brain: string, artifact: string): Promise<void> {
  // Container-private input, never beneath the /proof artifact bind aliases.
  const owned = fs.mkdtempSync("/tmp/odysseus-native-state-");
  const privateState = join(owned, "state");
  try {
  fs.mkdirSync(privateState); const secret = join(privateState, "state"); fs.writeFileSync(secret, "Odysseus private state");
  const crossLink = (source: string, name: string) => {
    let code: string | undefined;
    try { fs.linkSync(source, join(brain, name)); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
    expect(code, "CROSS_BOUNDARY_LINK_FAILS_EXDEV").toBe("EXDEV");
  };
  const proof = createOperationalStateProof(), layout = { brainPath: brain, privateStatePaths: [{ setting: "native proof", path: privateState }] };
  expect(proof(layout), "NATIVE_PROBE_PRIVATE_INPUT_MUST_BE_UNALIASED").toBeUndefined();
  const reads = spyOn(fs, "readdirSync"); let stateReads: number;
  const began = performance.now();
  try { expect(proof(layout), "NATIVE_PROBE_PRIVATE_INPUT_MUST_BE_UNALIASED").toBeUndefined(); stateReads = reads.mock.calls.length; expect(stateReads, "NATIVE_STATE_PROOF_NO_DIRECTORY_READS").toBe(0); }
  finally { reads.mockRestore(); }
  const stateProofMs = performance.now() - began;
  crossLink(secret, "state-alias");
  fs.writeFileSync(artifact, JSON.stringify({ stateDirectoryReads: stateReads!, stateProofMs, stateHardlink: "EXDEV", privateStateRoot: owned, artifactOutsideState: true }));
  } finally { fs.rmSync(owned, { recursive: true, force: true }); }
}
