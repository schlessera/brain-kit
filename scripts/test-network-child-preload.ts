import { installNetworkGuard } from "./test-network-guard";

const guard = installNetworkGuard();
try {
  const { afterEach, afterAll } = await import("bun:test");
  afterEach(() => guard.assertNoEscapes());
  afterAll(() => guard.assertNoEscapes());
} catch {
  // This is normally a CLI/helper process, which uses the exit listener.
}
