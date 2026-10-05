import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreQueryAccess, QueryCode, VoiceQueries } from "../src/core-queries";
import { buildKeyterms, getKeyterms, writeCache, type KeytermSettings } from "../src/voice/keyterm-builder";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function settings(voice: CoreQueryAccess["voice"], limit = 50): KeytermSettings {
  const brainPath = mkdtempSync(join(tmpdir(), "brain-ui-keyterms-"));
  dirs.push(brainPath);
  writeFileSync(join(brainPath, ".voice-overrides.md"), "- Penelope → pen-EL-oh-pee\n");
  return { brainPath, cacheDir: join(brainPath, ".brain-ui"), limit, queries: { graph: () => ({ ok: false, reason: "not_installed" }), voice } };
}

function answering(result: ReturnType<VoiceQueries["readVoiceVocabulary"]>, calls: unknown[]): CoreQueryAccess["voice"] {
  return () => ({ ok: true, queries: { readVoiceVocabulary: (opts) => { calls.push(opts); return result; } } });
}
const failure = (code: QueryCode) => ({ ok: false as const, error: { code, retryable: code === "busy_index" } });
const OVERRIDES = [{ match: "Penelope", replacement: "pen-EL-oh-pee" }];

test("terms are core's, in core's order, with the requested limit", () => {
  const calls: unknown[] = [];
  const s = settings(answering({ ok: true, value: { terms: ["Odysseus", "Ithaca"], extractorVersion: 2 }, snapshot: { schemaVersion: 15, newestIndexedAt: null } }, calls));
  const cache = getKeyterms(s);
  expect(cache).toMatchObject({ version: 2, keyterms: ["Odysseus", "Ithaca"], count: 2, overrides: OVERRIDES });
  expect(cache.degraded).toBeUndefined();
  expect(calls).toEqual([{ brainPath: s.brainPath, limit: 50 }]);
  expect(existsSync(join(s.cacheDir, "keyterms.json"))).toBe(true);
});

test("an empty valid vocabulary is a success, cached like any other", () => {
  const s = settings(answering({ ok: true, value: { terms: [], extractorVersion: 2 }, snapshot: { schemaVersion: 15, newestIndexedAt: null } }, []));
  expect(getKeyterms(s).degraded).toBeUndefined();
  expect(existsSync(join(s.cacheDir, "keyterms.json"))).toBe(true);
});

test("unusable core and an incompatible index degrade to overrides and are never persisted", () => {
  for (const voice of [
    (() => ({ ok: false, reason: "version_unsupported" })) as CoreQueryAccess["voice"],
    answering(failure("incompatible_index"), []),
  ]) {
    const s = settings(voice);
    const cache = getKeyterms(s);
    expect(cache).toMatchObject({ keyterms: [], count: 0, overrides: OVERRIDES, degraded: true });
    expect(existsSync(join(s.cacheDir, "keyterms.json"))).toBe(false);
    // The sync path writes through writeCache directly; it refuses too.
    writeCache(s, buildKeyterms(s));
    expect(existsSync(join(s.cacheDir, "keyterms.json"))).toBe(false);
  }
});

test("a missing index keeps its error; corrupt, locked or unreadable indexes are failures, not empty vocabularies", () => {
  expect(() => buildKeyterms(settings(answering(failure("missing_index"), [])))).toThrow(/^brain\.db not found at /);
  for (const code of ["corrupt_index", "busy_index", "unavailable_index"] as const) {
    expect(() => buildKeyterms(settings(answering(failure(code), [])))).toThrow(`(${code})`);
  }
});

test("a limit below one asks core for nothing", () => {
  const calls: unknown[] = [];
  const cache = buildKeyterms(settings(answering(failure("corrupt_index"), calls), 0));
  expect(cache).toMatchObject({ keyterms: [], count: 0, overrides: OVERRIDES });
  expect(calls).toEqual([]);
});
