import { describe, expect, test } from "bun:test";

import { deriveConnectionIssue } from "../src/components/connectivity/connection-state.js";
import type { VpnStatus } from "../src/stores/connection-store.js";

describe("connection issue derivation", () => {
  test.each([
    ["unauthorized", 0, null, "unauthorized"],
    ["forbidden", 3, 1006, "forbidden"],
    ["unreachable", 3, 1006, "unreachable"],
    ["checking", 3, 1006, null],
    ["connected", 2, 1006, null],
    // The cap refusal arrives as a close AFTER the upgrade is accepted, so the
    // never-opened counter is still 0 when it lands. Gating capacity on the
    // inferred threshold made the real refusal unreachable.
    ["connected", 0, 4008, "capacity"],
    ["connected", 2, 4008, "capacity"],
    ["connected", 3, 1006, "refused"],
    ["connected", 3, 4008, "capacity"],
  ] as const)(
    "%s with %i failed handshakes and close code %s derives %s",
    (vpnStatus, handshakeFailures, lastCloseCode, expected) => {
      expect(
        deriveConnectionIssue({
          vpnStatus: vpnStatus as VpnStatus,
          handshakeFailures,
          lastCloseCode,
        })
      ).toBe(expected);
    }
  );
});
