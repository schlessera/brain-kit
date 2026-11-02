import { afterAll, afterEach } from "bun:test";
import { cleanupCliUtilities } from "../packages/core/tests/cli-harness";
import { installNetworkGuard } from "./test-network-guard";
import { join, resolve } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ensureWorkspaceLease, workspaceTestAccess } from "./workspace-lease.mjs";

const guard = installNetworkGuard();
const coordinated = await ensureWorkspaceLease(resolve(import.meta.dir, ".."), workspaceTestAccess(), "test");
if (coordinated !== undefined) process.exit(coordinated);
// Commands a test spawns queue in a ledger private to this test process, never
// behind the host's real heavy commands (#2943). A test that exercises the host
// ledger names its own directory; an admitted caller's descendants inherit its slot.
const privateAdmission = process.env.BRAIN_HOST_ADMISSION_DIR ? undefined :
  join(tmpdir(), "brain-host-admission-tests", String(process.pid));
if (privateAdmission) process.env.BRAIN_HOST_ADMISSION_DIR = privateAdmission;
afterEach(() => guard.assertNoEscapes());
// A preload hook runs after all files; a hook in the cached helper would run
// after its first importing file. Bun test does not run the ordinary exit hook.
afterAll(() => {
  try {
    guard.assertNoEscapes();
  } finally {
    cleanupCliUtilities();
    if (privateAdmission) rmSync(privateAdmission, { recursive: true, force: true });
  }
});
