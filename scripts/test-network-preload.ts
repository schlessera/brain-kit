import { afterAll, afterEach } from "bun:test";
import { cleanupCliUtilities } from "../packages/core/tests/cli-harness";
import { installNetworkGuard } from "./test-network-guard";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ensureWorkspaceLease, processIdentity, workspaceTestAccess } from "./workspace-lease.mjs";

const guard = installNetworkGuard();
const coordinated = await ensureWorkspaceLease(resolve(import.meta.dir, ".."), workspaceTestAccess(), "test");
if (coordinated !== undefined) process.exit(coordinated);
// Commands a test spawns queue in a ledger private to this test process, never
// behind the host's real heavy commands (#2943). The path is testLedgerFor's
// convention in scripts/host-admission.mjs, so a descendant whose environment
// was replaced finds it through its ancestry. A test exercising the host ledger
// names its own directory; an admitted caller's descendants inherit its slot.
const privateAdmission = join(tmpdir(), `brain-host-admission-tests-${process.getuid?.() ?? "user"}`,
  `${process.pid}-${processIdentity(process.pid)?.start ?? "0"}`);
mkdirSync(privateAdmission, { recursive: true, mode: 0o700 });
process.env.BRAIN_HOST_ADMISSION_DIR = privateAdmission;
afterEach(() => guard.assertNoEscapes());
// A preload hook runs after all files; a hook in the cached helper would run
// after its first importing file. Bun test does not run the ordinary exit hook.
afterAll(() => {
  try {
    guard.assertNoEscapes();
  } finally {
    cleanupCliUtilities();
    rmSync(privateAdmission, { recursive: true, force: true });
  }
});
