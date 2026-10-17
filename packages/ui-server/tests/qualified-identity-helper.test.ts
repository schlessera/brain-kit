import { expect, test } from "bun:test";
import * as identity from "../../ui-sdk/src/server/worker-identity.js";
import { mockQualifiedIdentityHelper } from "./helpers/qualified-identity-helper";

test("qualified helper fixture scopes its one marker and restores real configuration validation", () => {
  const original = process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
  const descriptor = Object.getOwnPropertyDescriptor(identity, "workerIdentityHelper")!;
  const helper = mockQualifiedIdentityHelper();
  try {
    process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = helper.path;
    expect(identity.workerIdentityHelper(), "UNIT_HELPER_MARKER_REACHES_MOCKED_PROBE").toBe(helper.path);
    delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    expect(identity.workerIdentityHelper(), "UNIT_HELPER_NO_HELPER_PATH_REMAINS_REAL").toBeUndefined();
    process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = "   ";
    expect(() => identity.workerIdentityHelper(), "UNIT_HELPER_INVALID_CONFIG_REMAINS_REAL").toThrow("cannot be whitespace");
    process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = "relative-helper";
    expect(() => identity.workerIdentityHelper()).toThrow("must be an absolute executable path");
  } finally {
    helper.restore();
    if (original === undefined) delete process.env.BRAIN_UI_WORKER_IDENTITY_HELPER;
    else process.env.BRAIN_UI_WORKER_IDENTITY_HELPER = original;
  }
  expect(Object.getOwnPropertyDescriptor(identity, "workerIdentityHelper"), "UNIT_HELPER_LOOKUP_DESCRIPTOR_RESTORED").toEqual(descriptor);
});
