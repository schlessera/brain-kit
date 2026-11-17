/**
 * Every governed and strict Claude turn runs on the host inference relay
 * (#1665, #3314), whose route inputs a strict turn attests through its
 * manager-acquired startup view. A copied fixture view has no native
 * checkpoint to attest, so its root stands in, as the brain path does for a
 * governed turn. Any other view, and every path, keeps the real attestation.
 */
import { spyOn } from "bun:test";
import * as routeInputs from "../../src/native-route-inputs.js";
import { isFixtureStartupView } from "../../../ui-server/tests/helpers/fixture-native-startup.js";

const retain = routeInputs.retainNativeRouteInputs;

/** Returns the restore. Call it after the fixture acquisition stand-in is in place. */
export function standInFixtureRouteInputs(): () => void {
  const spy = spyOn(routeInputs, "retainNativeRouteInputs")
    .mockImplementation(source => retain(isFixtureStartupView(source) ? source.root : source));
  let restored = false;
  return () => { if (restored) return; restored = true; spy.mockRestore(); };
}
