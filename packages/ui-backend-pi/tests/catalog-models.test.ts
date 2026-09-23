// The models a deployment can put in its picker are the ones pi's builtin
// catalog knows (#194): `toModel` refuses anything else at session time. This
// pins the ids deployments are moving to, so a pi SDK pin that lacks them
// fails here rather than as `Unknown model` on a live turn.
import { describe, expect, test } from "bun:test";

import { toModel } from "../src/profiles";

describe("pi builtin catalog", () => {
  for (const model of ["gpt-6-sol", "gpt-6-luna"]) {
    test(`openai-codex/${model} resolves`, () => {
      const resolved = toModel({ vendor: "openai-codex", model });
      expect(resolved?.id).toBe(model);
      expect(resolved?.provider).toBe("openai-codex");
    });
  }

  test("an id the catalog does not carry is still refused", () => {
    expect(() => toModel({ vendor: "openai-codex", model: "gpt-0-nonexistent" })).toThrow(
      /Unknown model "openai-codex\/gpt-0-nonexistent"/
    );
  });
});
