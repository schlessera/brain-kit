/**
 * What the pi backend replays as a user message's text, for a message sent
 * with attachments and with a client environment.
 *
 * ui-server joins what it keeps about a user message (how it was produced:
 * typed, dictated, spoken) onto the replayed message by the message's EXACT
 * text as the client sent it. These pin that pi replays that text: the
 * client environment never reaches the stored message, and the notes pi
 * appends about the images it resized or converted are not replayed as the
 * user's words.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  formatDimensionNote,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ClientEnvironment } from "@schlessera/brain-ui-sdk/server";

import { createPiBackend, type PiSessionLike } from "../src/backend";
import { getPiHistory, stripImageNotes } from "../src/history";
import { makeEmptyBrain } from "./helpers";
import { makeMockBridge } from "./mock-bridge";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The note pi's own `formatDimensionNote` writes for a resized image. */
function resizeNote(): string {
  const note = formatDimensionNote({
    data: "",
    mimeType: "image/png",
    originalWidth: 4032,
    originalHeight: 3024,
    width: 2016,
    height: 1512,
    wasResized: true,
  });
  if (!note) throw new Error("formatDimensionNote wrote no note for a resized image");
  return note;
}

/**
 * Store one user message the way `AgentSession.prompt` does in pi 0.87.1:
 * one text part holding the prompt, then a blank line and one note per image
 * it normalised, then the images. Read it back through the reader the
 * backend replays history with.
 */
async function replayUserText(content: unknown[]): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-replayed-text-"));
  roots.push(cwd);
  const sessionDir = join(cwd, "sessions");
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({ role: "user", content, timestamp: 1 } as never);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Noted." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  } as never);
  const history = await getPiHistory(cwd, manager.getSessionId(), sessionDir);
  const user = history.find((message) => message.role === "user");
  if (!user) throw new Error("no user message replayed");
  return user.content;
}

describe("pi replays a user message as the text the client sent", () => {
  test("the client environment and the attachments never reach the prompt text", async () => {
    const brain = makeEmptyBrain();
    try {
      const prompts: Array<{ text: string; images: unknown[] }> = [];
      const session: PiSessionLike = {
        sessionId: "S",
        subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
        async prompt(text, options) {
          prompts.push({ text, images: (options as { images?: unknown[] } | undefined)?.images ?? [] });
        },
        async abort() {},
        getSessionStats: () => ({ cost: 0 }),
        dispose() {},
      };
      const backend = createPiBackend({
        brainPath: brain.root,
        sessionFactory: { newSession: async () => session, openSession: async () => session },
      });
      const client: ClientEnvironment = { formFactor: "phone", viewportWidth: 390, locale: "en-GB", timeZone: "Europe/Berlin" };
      await backend.startTurn({
        prompt: "What is in this picture?",
        attachments: [{ mediaType: "image/png", data: PNG_1PX }],
        client,
        signal: new AbortController().signal,
        bridge: makeMockBridge().bridge,
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.text).toBe("What is in this picture?");
      expect(prompts[0]!.images).toHaveLength(1);
    } finally {
      brain.cleanup();
    }
  });

  test("a resized image's note is not replayed as the user's words", async () => {
    const note = resizeNote();
    const replayed = await replayUserText([
      { type: "text", text: `What is in this picture?\n\n${note}` },
      { type: "image", data: PNG_1PX, mimeType: "image/png" },
    ]);
    expect(replayed).toBe("What is in this picture?");
  });

  test("an image-only message with a converted, resized image replays as empty text", async () => {
    const replayed = await replayUserText([
      { type: "text", text: `\n\n[Image converted from image/heic to image/jpeg.]\n${resizeNote()}` },
      { type: "image", data: PNG_1PX, mimeType: "image/jpeg" },
    ]);
    expect(replayed).toBe("");
  });

  test("a message with no image notes replays unchanged", async () => {
    const replayed = await replayUserText([
      { type: "text", text: "Two lines\n\nof my own" },
      { type: "image", data: PNG_1PX, mimeType: "image/png" },
    ]);
    expect(replayed).toBe("Two lines\n\nof my own");
  });
});

describe("stripImageNotes", () => {
  test("removes only a trailing run of notes after a blank line", () => {
    const omitted = "[Image omitted: could not be resized below the inline image size limit.]";
    expect(stripImageNotes(`Look\n\n${omitted}`)).toBe("Look");
    // Words after a note mean the note is the user's, not pi's.
    expect(stripImageNotes(`Look\n\n${omitted}\nand this`)).toBe(`Look\n\n${omitted}\nand this`);
    // No blank line before it: the user typed it.
    expect(stripImageNotes(`Look ${omitted}`)).toBe(`Look ${omitted}`);
  });
});
