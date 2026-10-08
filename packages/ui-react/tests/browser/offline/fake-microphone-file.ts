/**
 * Node side of the fake microphone (#1016): writes the fixture Chromium plays
 * through `--use-file-for-fake-audio-capture` and returns its path.
 *
 * Called by `packages/ui-kit/vitest.config.ts` when the config loads, because
 * Chromium reads the file at launch. The file name carries the bytes' hash,
 * so a stale file from another generator version is never reused.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIO_FIXTURES, generateWav, type AudioFixtureSpec } from "./audio-fixtures.ts";

/** The fake microphone's source: the 10-second note, looped by Chromium. */
export const FAKE_MICROPHONE_FIXTURE: AudioFixtureSpec = AUDIO_FIXTURES.note10s;

export function fakeMicrophoneFile(spec: AudioFixtureSpec = FAKE_MICROPHONE_FIXTURE): string {
  const bytes = generateWav(spec);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "brain-kit-audio-fixtures");
  const file = join(dir, `${spec.name}-${hash}.wav`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    // Write then rename: two configs loading at once never see a half file.
    const partial = `${file}.${process.pid}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, file);
  }
  return file;
}
