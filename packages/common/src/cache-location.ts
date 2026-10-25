/**
 * Where a brain keeps its committed caches of generated text.
 *
 * Internal to brain-kit: reached through
 * `@schlessera/brain-common/internal/cache-location`, with no compatibility
 * promise for the module itself. The locations it names are part of the
 * integration contract (docs/integration-contract/frontmatter.md, "Committed
 * sidecars").
 *
 * The chunk-context and asset-description caches hold text a model generated
 * from documents, masked ones included. They live together in one directory
 * below the brain root, never as loose files in the root: a directory can be
 * retained and masked as a whole inside a worker's mount namespace, where a
 * loose file mask detaches when a peer unlinks or renames the path it covers
 * (docs/decisions/governed-writable-workers.md, "Generated-text caches").
 *
 * Unlike the index, the caches are committed and paid for, so a brain from an
 * older release migrates by moving their lines, never by regenerating them.
 */

/** Repo-relative directory holding the committed caches of generated text. */
export const CACHE_DIR = ".brain-cache";

/** Repo-relative path of the chunk-context cache. */
export const CONTEXT_CACHE_PATH = `${CACHE_DIR}/contexts.jsonl`;

/** Repo-relative path of the asset-description cache. */
export const ASSET_CACHE_PATH = `${CACHE_DIR}/assets.jsonl`;

/** Both committed caches, chunk contexts first. */
export const SIDECAR_CACHES = [CONTEXT_CACHE_PATH, ASSET_CACHE_PATH] as const;

/**
 * The root-level names releases before 0.44.0 kept the caches under, each
 * paired with the path its lines move to. A clone that still has one, from
 * before the move or merged in from an older clone, keeps every line: the
 * next index run unions it into the new file and deletes it.
 */
export const LEGACY_SIDECAR_CACHES = [
  { legacy: ".context-cache.jsonl", current: CONTEXT_CACHE_PATH },
  { legacy: ".asset-cache.jsonl", current: ASSET_CACHE_PATH },
] as const;

/** Every path a cache of generated text is committed under: the new ones, then the legacy root-level names. */
export const GENERATED_CACHE_PATHS: readonly string[] = [...SIDECAR_CACHES, ...LEGACY_SIDECAR_CACHES.map(pair => pair.legacy)];
