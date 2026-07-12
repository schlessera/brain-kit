import { describe, expect, test } from "bun:test";

import { BackendRequestError } from "@brainform/ui-sdk/server";

import { createPiBackend } from "../src/backend";
import { makeEmptyBrain } from "./helpers";
import { makeMockBridge } from "./mock-bridge";

describe("createPiBackend (no LLM)", () => {
  test("id and capabilities are stable and honest", () => {
    const brain = makeEmptyBrain();
    try {
      const backend = createPiBackend({ brainPath: brain.root });
      expect(backend.id).toBe("pi");
      expect(backend.capabilities).toEqual({
        resume: true,
        permissions: true,
        thinking: true,
        attachments: true,
        askUser: true,
        costReporting: true,
      });
    } finally {
      brain.cleanup();
    }
  });

  test("listProfiles maps configured profiles", () => {
    const brain = makeEmptyBrain();
    try {
      const backend = createPiBackend({
        brainPath: brain.root,
        profiles: [
          { id: "sonnet", label: "Claude Sonnet", vendor: "anthropic", model: "claude-sonnet-4-5" },
          { id: "gpt", label: "GPT", vendor: "openai", model: "gpt-5" },
        ],
      });
      expect(backend.listProfiles()).toEqual([
        { id: "sonnet", label: "Claude Sonnet", vendor: "anthropic" },
        { id: "gpt", label: "GPT", vendor: "openai" },
      ]);
    } finally {
      brain.cleanup();
    }
  });

  test("listProfiles derives a default from a model string", () => {
    const brain = makeEmptyBrain();
    try {
      const backend = createPiBackend({ brainPath: brain.root, model: "anthropic/claude-sonnet-4-5" });
      expect(backend.listProfiles()).toEqual([
        { id: "default", label: "anthropic/claude-sonnet-4-5", vendor: "anthropic" },
      ]);
    } finally {
      brain.cleanup();
    }
  });

  test("listProfiles is empty when nothing is configured", () => {
    const brain = makeEmptyBrain();
    try {
      expect(createPiBackend({ brainPath: brain.root }).listProfiles()).toEqual([]);
    } finally {
      brain.cleanup();
    }
  });

  test("startTurn rejects an unknown profileId (caller error) without a session", async () => {
    const brain = makeEmptyBrain();
    try {
      const backend = createPiBackend({
        brainPath: brain.root,
        profiles: [{ id: "sonnet", label: "S", vendor: "anthropic", model: "claude-sonnet-4-5" }],
      });
      const mock = makeMockBridge();
      await expect(
        backend.startTurn({
          prompt: "hi",
          profileId: "does-not-exist",
          signal: new AbortController().signal,
          bridge: mock.bridge,
        })
      ).rejects.toBeInstanceOf(BackendRequestError);
      // Nothing should have been emitted for a rejected caller error.
      expect(mock.emitted).toHaveLength(0);
    } finally {
      brain.cleanup();
    }
  });

  test("listSessions on a fresh brain returns an empty list", async () => {
    const brain = makeEmptyBrain();
    try {
      const backend = createPiBackend({ brainPath: brain.root });
      expect(await backend.listSessions()).toEqual([]);
    } finally {
      brain.cleanup();
    }
  });
});
