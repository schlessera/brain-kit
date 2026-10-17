import { expect, test } from "bun:test";
import * as client from "@schlessera/brain-ui-sdk/client";
test("public client exposes content-renderer registration", () => {
  expect((client as unknown as Record<string, unknown>).registerContentRenderers, "CONTENT_RENDERER_PUBLIC_REGISTRATION").toBeFunction();
});
