import { afterAll, afterEach } from "bun:test";
import { cleanupCliUtilities, setCliUtilityRoot } from "../packages/core/tests/cli-harness";
import { installNetworkGuard } from "./test-network-guard";
import { installTestAdmission, installTestHome } from "./test-home";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { ensureWorkspaceLease, processIdentity, workspaceTestAccess } from "./workspace-lease.mjs";

const guard = installNetworkGuard();
const coordinated = await ensureWorkspaceLease(resolve(import.meta.dir, ".."), workspaceTestAccess(), "test");
if (coordinated !== undefined) process.exit(coordinated);
const admissionIdentity = { pid: process.pid, start: processIdentity(process.pid)?.start ?? "0" };
// Consume the one-generation handoff so nested raw Bun children own their
// fallback storage. Bun restores its startup environment on watch reloads,
// reattaching those reloads to the same launcher-owned resource tree.
const resourceRoot = process.env.BRAIN_TEST_RESOURCE_ROOT;
delete process.env.BRAIN_TEST_RESOURCE_ROOT;
const testHome = installTestHome(resourceRoot);
setCliUtilityRoot(testHome.root);
// Commands a test spawns use its PID/start private ledger, including descendants
// with replaced environments. Only the same identity may reuse it on watch.
const privateAdmission = installTestAdmission(admissionIdentity, resourceRoot);
process.env.BRAIN_HOST_ADMISSION_DIR = privateAdmission;
afterEach(() => guard.assertNoEscapes());
// Bun repeats the preload's afterAll for the last file under --rerun-each,
// and does not emit ordinary exit hooks. Keep assertions here, but leave
// launcher-owned resources live until the parent observes the entire group end.
afterAll(() => {
  try {
    guard.assertNoEscapes();
  } finally {
    if (!resourceRoot) {
      cleanupCliUtilities();
      rmSync(privateAdmission, { recursive: true, force: true });
      testHome.dispose();
    }
  }
});
