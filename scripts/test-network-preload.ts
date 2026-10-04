import { afterAll, afterEach } from "bun:test";
import { cleanupCliUtilities } from "../packages/core/tests/cli-harness";
import { installNetworkGuard } from "./test-network-guard";

const guard = installNetworkGuard();
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
