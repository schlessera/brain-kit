import { afterAll, afterEach } from "bun:test";
import { cleanupCliUtilities } from "../packages/core/tests/cli-harness";
import { installNetworkGuard } from "./test-network-guard";
import { resolve } from "node:path";
import { ensureWorkspaceLease, workspaceTestAccess } from "./workspace-lease.mjs";

const guard = installNetworkGuard();
const coordinated = await ensureWorkspaceLease(resolve(import.meta.dir, ".."), workspaceTestAccess(), "test");
if (coordinated !== undefined) process.exit(coordinated);
afterEach(() => guard.assertNoEscapes());
// A preload hook runs after all files; a hook in the cached helper would run
// after its first importing file. Bun test does not run the ordinary exit hook.
afterAll(() => {
  try {
    guard.assertNoEscapes();
  } finally {
    cleanupCliUtilities();
  }
});
