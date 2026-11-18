import { afterAll, afterEach } from "bun:test";
import { cleanupCliUtilities, setCliUtilityRoot } from "../packages/core/tests/cli-harness";
import { installNetworkGuard } from "./test-network-guard";
import { installTestHome } from "./test-home";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ensureWorkspaceLease, processIdentity, workspaceTestAccess } from "./workspace-lease.mjs";

const guard = installNetworkGuard();
const coordinated = await ensureWorkspaceLease(resolve(import.meta.dir, ".."), workspaceTestAccess(), "test");
if (coordinated !== undefined) process.exit(coordinated);
// Consume this one-generation marker: a nested raw Bun test owns its own
// fallback lifetime rather than borrowing its parent's resource tree.
const resourceRoot = process.env.BRAIN_TEST_RESOURCE_ROOT;
delete process.env.BRAIN_TEST_RESOURCE_ROOT;
const testHome = installTestHome(resourceRoot);
setCliUtilityRoot(testHome.root);
// Commands a test spawns queue in a ledger private to this test process, never
// behind the host's real heavy commands (#2943). The path is testLedgerFor's
// convention in scripts/host-admission.mjs, so a descendant whose environment
// was replaced finds it through its ancestry. A test exercising the host ledger
// names its own directory; an admitted caller's descendants inherit its slot.
// The launcher owns its ledger until the child group has drained. Raw Bun
// invocations retain the existing afterAll fallback.
const admissionIdentity = { pid: process.pid, start: processIdentity(process.pid)?.start ?? "0" };
const privateAdmission = join(tmpdir(),
  `brain-host-admission-test-${process.getuid?.() ?? "user"}-${admissionIdentity.pid}-${admissionIdentity.start}`);
// Preserve this test process's conventional identity for environment-free
// descendants. Register before creation so parent cleanup also covers startup
// failure or cancellation between ledger setup and the first test.
if (resourceRoot) writeFileSync(join(resourceRoot, "admission.json"), JSON.stringify(admissionIdentity));
mkdirSync(privateAdmission, { mode: 0o700 });
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
