/** The write observation is saved off the event loop (#2416), and still before the write. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { NativeFileVersions } from "@schlessera/brain-ui-sdk/internal";
import { createPermissionWiring } from "../src/permission-hooks";
import { createTurnLockBinding } from "../src/turn-lock";

test("a native write is refused when its observation cannot be saved first", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-retention-")), brain = join(root, "brain"), storage = join(root, "observations");
  mkdirSync(brain); const path = join(brain, "loom.md"); writeFileSync(path, "Penelope weaves.\n");
  try {
    const fileVersions = new NativeFileVersions();
    await fileVersions.retain({ directory: storage, brainPath: brain, sessionId: "ithaca" });
    // The storage directory is redirected after it was retained: the next save fails.
    const moved = storage + "-peer"; mkdirSync(moved); rmSync(storage, { recursive: true }); symlinkSync(moved, storage);
    const controller = new AbortController();
    const turnLock = createTurnLockBinding({ turn: { ended: false, pendingReleases: new Map() }, writeLock: createKeyedLock(), lockWaitMs: 1000, log: () => {} });
    const wiring = createPermissionWiring({ req: { prompt: "Return to Ithaca.", signal: controller.signal,
      workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] }, bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } } as never,
      allowedTools: ["Read", "Write"], confirmPatterns: [], brainPath: brain, turnLock, childEnv: { PATH: "/usr/bin:/bin" }, log: () => {}, fileVersions });
    const decision = (await wiring.canUseTool!("Write", { file_path: path, content: "Athena charts.\n" }, { signal: controller.signal, toolUseID: "toolu_ithaca_write", suggestions: [] } as never))!;
    expect(decision.behavior, "UNSAVED_OBSERVATION_REFUSES_WRITE").toBe("deny");
    expect((decision as { message?: string }).message).toContain("could not retain this write observation");
    expect(readFileSync(path, "utf8")).toBe("Penelope weaves.\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
