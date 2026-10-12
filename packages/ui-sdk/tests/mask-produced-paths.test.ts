import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { BackendBridge } from "../src/server/backend.js";
import { claudeMaskFilename, claudeReportedMaskPath, handleRequestImageMask, piMaskFilename, piReportedMaskPath } from "../src/server/bridge-tools/mask.js";

const maskBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

for (const adapter of ["claude", "pi"] as const) {
  for (const entry of ["relative", "alias"] as const) {
    test(`${adapter} fallback preserves its produced mask through host prune with a ${entry} input`, async () => {
      const root = mkdtempSync(join(tmpdir(), "brain-mask-produced-"));
      try {
        const scratch = join(root, ".brain", "scratch");
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
        writeFileSync(join(scratch, "shroud.png"), maskBytes);
        writeFileSync(join(scratch, "old.png"), maskBytes);
        symlinkSync(scratch, join(root, "outputs"));
        const imagePath = entry === "alias" ? "outputs/shroud.png" : ".brain/scratch/shroud.png";
        const maskName = adapter === "claude" ? "shroud-mask.png" : "shroud.mask.png";
        const maskRel = `.brain/scratch/${maskName}`;
        let pruneCalls = 0;
        let producedPaths: readonly string[] | undefined;
        const bridge = {
          requestMask: async () => maskBytes,
          pruneScratch: async (produced?: readonly string[]) => {
            pruneCalls++;
            producedPaths = produced;
            // The real writer has finished before the host receives its pins.
            expect(readFileSync(join(scratch, maskName)), "NONEMPTY_MASK_BEFORE_PRUNE").toEqual(Buffer.from(maskBytes));
            const pins = new Set(produced ?? []);
            for (const name of ["shroud.png", "old.png", maskName]) {
              const path = join(scratch, name);
              if (!pins.has(relative(root, path).split(sep).join("/"))) rmSync(path);
            }
          },
        } as unknown as BackendBridge;
        const result = await handleRequestImageMask({ imagePath, instruction: "Repair the shroud." }, bridge, {
          brainPath: root,
          maskFilename: adapter === "claude" ? claudeMaskFilename : piMaskFilename,
          reportMaskPath: adapter === "claude" ? claudeReportedMaskPath : piReportedMaskPath,
        });
        expect(existsSync(resolve(root, result.maskPath)), "REPORTED_MASK_SURVIVES_HOST_PRUNE").toBe(true);
        expect(readFileSync(resolve(root, result.maskPath))).toEqual(Buffer.from(maskBytes));
        expect(result.bytes).toBe(maskBytes.length);
        expect(producedPaths, "CANONICAL_BRAIN_RELATIVE_PRODUCER_PIN").toEqual([maskRel]);
        expect(pruneCalls).toBe(1);
        expect(existsSync(join(scratch, "old.png")), "UNPINNED_OUTPUT_ACTUALLY_PRUNED").toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  test(`${adapter} uses the provided mask application without invoking fallback prune`, async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-mask-produced-"));
    try {
      const scratch = join(root, ".brain", "scratch");
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, "shroud.png"), maskBytes);
      let applications = 0, prunes = 0;
      const bridge = {
        requestMask: async () => maskBytes,
        applyImageMask: async ({ maskPath, png }: { maskPath: string; png: Uint8Array }) => {
          applications++;
          writeFileSync(join(root, maskPath), png);
          return { ok: true };
        },
        pruneScratch: async () => { prunes++; throw new Error("provided application owns its prune"); },
      } as unknown as BackendBridge;
      const result = await handleRequestImageMask({ imagePath: ".brain/scratch/shroud.png" }, bridge, {
        brainPath: root,
        maskFilename: adapter === "claude" ? claudeMaskFilename : piMaskFilename,
        reportMaskPath: adapter === "claude" ? claudeReportedMaskPath : piReportedMaskPath,
      });
      expect(readFileSync(join(root, result.maskPath))).toEqual(Buffer.from(maskBytes));
      expect(applications).toBe(1);
      expect(prunes).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
