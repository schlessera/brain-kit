import type { Logger } from "@opentelemetry/api-logs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { PronunciationOverride } from "@schlessera/brain-ui-sdk/protocol";
import { defaultCoreQueryAccess, CORE_PACKAGE, type CoreQueryAccess } from "../core-queries.js";

/**
 * Everything the keyterm builder needs to know about its surroundings —
 * derived from the resolved ServerConfig by the caller (createApp / the
 * deployment shell). No ambient environment.
 */
export interface KeytermSettings {
  brainPath: string;
  /** Directory holding keyterms.json (VOICE_CACHE_DIR). */
  cacheDir: string;
  /** Maximum vocabulary size (VOICE_KEYTERM_LIMIT). */
  limit: number;
  /** Where degradation is reported; absent means silence. */
  log?: Logger;
  /**
   * The app's lazily resolved core query access. Omitted, the builder uses
   * one shared per process — the case of a deployment script calling
   * `buildKeyterms` on its own.
   */
  queries?: CoreQueryAccess;
}

// Tracks core's vocabulary extractor (`extractorVersion` 2 of
// `readVoiceVocabulary`): bump it whenever that extraction, its scoring or its
// stoplists change, so that post-deploy the first request rebuilds the cache
// instead of serving a snapshot baked under the old algorithm.
const CACHE_VERSION = 2;

function cachePath(settings: KeytermSettings): string {
  return join(settings.cacheDir, "keyterms.json");
}

function overridesPath(brainPath: string): string {
  return join(brainPath, ".voice-overrides.md");
}

export interface KeytermsCache {
  version: number;
  keyterms: string[];
  generatedAt: number;
  count: number;
  overrides: PronunciationOverride[];
  /**
   * Set when no vocabulary could be extracted — the index is of a version
   * core cannot read, or no usable core query package is installed. The
   * vocabulary degrades to empty (voice keeps working, just without domain
   * bias) instead of erroring. Degraded results are never persisted, so the
   * first request after the condition clears rebuilds.
   */
  degraded?: true;
}

export function loadOverrides(brainPath: string, log?: Logger): PronunciationOverride[] {
  const path = overridesPath(brainPath);
  if (!existsSync(path)) return [];
  try {
    const md = readFileSync(path, "utf-8");
    const out: PronunciationOverride[] = [];
    for (const line of md.split("\n")) {
      // Format:  - Doe → DOH   (also accepts "->")
      const m = line.match(/^\s*-\s+(.+?)\s+(?:→|->)\s+(.+?)\s*$/);
      if (!m) continue;
      const match = m[1].trim();
      const replacement = m[2].trim();
      if (match && replacement) out.push({ match, replacement });
    }
    return out;
  } catch (err) {
    log?.emit({
      severityText: "WARN",
      body: "failed to load pronunciation overrides",
      attributes: { error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }
}

function degraded(settings: KeytermSettings): KeytermsCache {
  return {
    version: CACHE_VERSION,
    keyterms: [],
    generatedAt: Date.now(),
    count: 0,
    overrides: loadOverrides(settings.brainPath, settings.log),
    degraded: true,
  };
}

/**
 * Build the vocabulary from core's `readVoiceVocabulary`, which owns the
 * extraction, scoring, deduplication and ranking. This module keeps what is
 * the UI's: pronunciation overrides from markdown, the cache file and the
 * degradation policy.
 */
export function buildKeyterms(settings: KeytermSettings): KeytermsCache {
  const { brainPath, log } = settings;
  const capability = (settings.queries ?? defaultCoreQueryAccess()).voice();
  if (!capability.ok) {
    // No usable core: voice still works, without domain bias. The access has
    // already logged why, once.
    return degraded(settings);
  }

  // A limit below one asks for no terms; core accepts only a positive integer.
  const limit = Math.min(Math.floor(settings.limit), Number.MAX_SAFE_INTEGER);
  if (!(limit >= 1)) {
    return { version: CACHE_VERSION, keyterms: [], generatedAt: Date.now(), count: 0, overrides: loadOverrides(brainPath, log) };
  }
  const result = capability.queries.readVoiceVocabulary({ brainPath, limit });
  if (result.ok) {
    const keyterms = result.value.terms;
    return {
      version: CACHE_VERSION,
      keyterms,
      generatedAt: Date.now(),
      count: keyterms.length,
      overrides: loadOverrides(brainPath, log),
    };
  }
  const { code } = result.error;
  if (code === "missing_index") {
    // Preserved behavior: no brain.db is a hard error the caller reports.
    throw new Error(`brain.db not found at ${join(brainPath, "brain.db")}`);
  }
  if (code === "incompatible_index") {
    // An index core cannot read: degrade to no custom vocabulary rather than
    // breaking voice entirely. Pronunciation overrides live in markdown, so
    // they survive.
    log?.emit({
      severityText: "WARN",
      body:
        `brain.db is not an index version the installed ${CORE_PACKAGE} reads; serving an ` +
        "empty custom vocabulary until the repo is re-indexed",
      attributes: { "index.error": code },
    });
    return degraded(settings);
  }
  // Corrupt, unreadable or locked: a failure, not an empty vocabulary.
  throw new Error(`brain.db could not be read for voice vocabulary (${code})`);
}

/** Persist a built cache. A degraded result is never written. */
export function writeCache(settings: KeytermSettings, cache: KeytermsCache): void {
  if (cache.degraded) return;
  const path = cachePath(settings);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
}

export function readCache(settings: KeytermSettings): KeytermsCache | null {
  const path = cachePath(settings);
  if (!existsSync(path)) return null;
  try {
    const cache = JSON.parse(readFileSync(path, "utf-8")) as KeytermsCache;
    if (cache.version !== CACHE_VERSION) return null;
    return cache;
  } catch {
    return null;
  }
}

export function getKeyterms(settings: KeytermSettings, forceRebuild = false): KeytermsCache {
  if (!forceRebuild) {
    const cached = readCache(settings);
    if (cached) return cached;
  }
  const fresh = buildKeyterms(settings);
  // A degraded result is served but never persisted — the cache must not
  // outlive the condition that produced it.
  writeCache(settings, fresh);
  return fresh;
}
