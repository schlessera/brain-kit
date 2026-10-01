import { makeFakeBackend } from "./helpers/fake-backend.js";
import { expect, test } from "bun:test";
import { resolveServerConfig } from "../src/config/env.js";
import { WsHost } from "../src/ws/host.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createUiDb } from "../src/db/client.js";

test("environment defaults and all three overrides reach host configuration; invalid values refuse startup", () => {
  expect(resolveServerConfig({}).askUserFormLimits).toEqual({
    maxDepth: 3,
    maxNodes: 12,
    maxOptions: 8,
  });
  const config = resolveServerConfig({
    BRAIN_UI_ASK_USER_FORM_MAX_DEPTH: "4",
    BRAIN_UI_ASK_USER_FORM_MAX_NODES: "20",
    BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS: "9",
  });
  const db = createUiDb(":memory:");
  const host = new WsHost({
    registry: createStaticBackendRegistry(
      [makeFakeBackend({ id: "fake" })],
      "fake",
    ),
    catalog: createSessionCatalog(() => db),
    askUserFormLimits: config.askUserFormLimits,
  });
  try {
    expect(host.askUserFormLimits).toEqual({
      maxDepth: 4,
      maxNodes: 20,
      maxOptions: 9,
    });
  } finally {
    host.close();
    db.close();
  }
  for (const name of [
    "BRAIN_UI_ASK_USER_FORM_MAX_DEPTH",
    "BRAIN_UI_ASK_USER_FORM_MAX_NODES",
    "BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS",
  ]) {
    for (const value of ["0", "-1", "1.5", "nope", ""])
      expect(() => resolveServerConfig({ [name]: value })).toThrow();
  }
});
