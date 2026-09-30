import { afterAll, afterEach } from "bun:test";
import { installNetworkGuard } from "./test-network-guard";

const guard = installNetworkGuard();
afterEach(() => guard.assertNoEscapes());
afterAll(() => guard.assertNoEscapes());
