/** Host-observation unit tests already replace actual probe execution. */
import { spyOn } from "bun:test";
import * as identity from "../../../ui-sdk/src/server/worker-identity.js";

/** Real helper/root/mode qualification belongs to the native runtime proof. */
export function mockQualifiedIdentityHelper() {
  const path = "/fixture/qualified-identity-helper", original = identity.workerIdentityHelper;
  const lookup = spyOn(identity, "workerIdentityHelper").mockImplementation(() =>
    process.env.BRAIN_UI_WORKER_IDENTITY_HELPER === path ? path : original());
  return { path, restore: () => lookup.mockRestore() };
}
