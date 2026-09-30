/**
 * The one copy of "a brain that actually holds vectors", built keyless.
 *
 * Staging real vectors needs no API key and no network: sqlite-vec is a local
 * extension and an `EmbeddingProvider` is four methods. That recipe had been
 * copied into every file that wanted it — four private extension probes and
 * three private fake providers — while the corpus/spawned-CLI tier, which is
 * where the numbers a consumer reads are asserted, had none of them. The
 * spawned bin runs keyless, so `brain index` there leaves `vec_chunks` empty
 * and `embeddings: 0` was the right answer arrived at for the wrong reason —
 * indistinguishable from a count that failed and was swallowed. Two shipped
 * defects lived in that gap (#136, #135).
 *
 * Not a test file (no `.test.ts`), so `bun test` does not execute it.
 *
 * ## What happens when sqlite-vec cannot load
 *
 * `embedTempBrain` throws, naming the extension; it never hands back a brain
 * with zero vectors. A fixture whose whole purpose is a known, non-zero vector
 * count has one useful failure mode, and a suite that went green because the
 * extension vanished would rebuild the blind spot this fixture exists to
 * close. sqlite-vec is a plain dependency of this package, so a load failure
 * is a broken install rather than an environment to degrade for.
 *
 * `vecAvailable` answers a different question — whether to run a vector suite
 * at all — and the files that already skip on it keep that choice. It is
 * exported here so there is one probe rather than four.
 */

import { Database } from "bun:sqlite";

import { initContext, setContext } from "../src/lib/context";
import { migrateVecSchema, openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import type { EmbeddingProvider } from "../src/lib/seams";

/** Vector width every fixture here is built at — deliberately not the default. */
export const VEC_DIMENSIONS = 16;

/** Whether sqlite-vec loads in this environment. One probe for the whole suite. */
export const vecAvailable: boolean = await (async () => {
  const probe = new Database(":memory:");
  try {
    const { load } = await import("sqlite-vec");
    load(probe);
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
})();

/**
 * Load sqlite-vec onto `db`, or fail saying so. vec0 is a per-connection
 * module, so every connection that touches `vec_chunks` needs this.
 *
 * The throw is the policy: a fixture that stages or reads a known vector count
 * has nothing useful to say without the extension, and answering 0 is the
 * swallowed failure these fixtures exist to rule out.
 */
export async function loadVec(db: Database): Promise<void> {
  try {
    const { load } = await import("sqlite-vec");
    load(db);
  } catch (e) {
    throw new Error(`sqlite-vec could not be loaded: ${(e as Error).message}`);
  }
}

/**
 * A deterministic stand-in for a paid provider: constant vectors, no network.
 * Distances between them are meaningless, which is fine — anything asserting
 * on ranking stages its vectors by hand instead.
 */
export function fakeEmbeddingProvider(
  dimensions: number = VEC_DIMENSIONS,
  opts: { id?: string; fill?: number } = {}
): EmbeddingProvider {
  const fill = opts.fill ?? 0.1;
  return {
    id: opts.id ?? `fake:${dimensions}`,
    dimensions,
    async embed(texts) {
      return texts.map(() => new Float32Array(dimensions).fill(fill));
    },
    async embedQuery() {
      return new Float32Array(dimensions).fill(fill);
    },
  };
}

/**
 * Index `root` in-process with a fake provider, so its `brain.db` carries real
 * vectors. Returns how many `vec_chunks` rows it wrote.
 *
 * The embedding pass is the real one — `indexAll` with `embeddings: true` —
 * rather than a hand-built vec0 table, so the fixture matches what an embedded
 * brain looks like, down to the `embedding_model` and `embedding_dimensions`
 * metadata. The run happens in-process because a spawned `brain index` has no
 * way to be handed an injected provider, and the keyless env it runs under is
 * the reason this gap exists.
 *
 * `root` is a temp brain from `makeTempBrain()`: the fixture corpus plus the
 * `node_modules` symlink its `brain.config.ts` needs.
 */
export async function embedTempBrain(
  root: string,
  opts: { dimensions?: number } = {}
): Promise<number> {
  const dimensions = opts.dimensions ?? VEC_DIMENSIONS;
  const provider = fakeEmbeddingProvider(dimensions);

  // `initContext` also sets the process-wide context, and bun runs a suite's
  // files in one process. Staging a fixture is not a reason to leave another
  // file's brain pointing at a temp dir that is about to be deleted.
  const previous = setContext(null);
  const ctx = await initContext({ root });
  setContext(previous);

  const db = openDatabase(ctx.dbPath, {
    embeddingModel: provider.id,
    embeddingDimensions: dimensions,
  });
  try {
    // The embedding pass is a silent no-op on a connection the extension is
    // not loaded on, and `migrateVecSchema` reports a failed load by returning
    // false and writing nothing. Either way the result would be a brain with
    // zero vectors — the exact answer this fixture exists to rule out — so the
    // load is asked for explicitly and fails loudly.
    await loadVec(db);
    if (!(await migrateVecSchema(db, dimensions))) {
      throw new Error("the vector schema could not be created: an embedded brain cannot be staged");
    }

    await indexAll(db, {
      root,
      taxonomy: ctx.taxonomy,
      quiet: true,
      embeddings: true,
      provider,
      // A fully embedded fixture needs real descriptions: unfinished asset
      // placeholders deliberately have no vector (#411). Keep chunk contexts
      // on the same summary fallback this fixture used without enrichment.
      enrichment: {
        async describeAsset(_buffer, _mimeType, title) {
          return `A fixture asset titled "${title}".`;
        },
        async generateChunkContext(_title, _text, _heading, _content, summary) {
          return summary ?? "";
        },
      },
    });

    const { count } = db.query("SELECT COUNT(*) AS count FROM vec_chunks").get() as {
      count: number;
    };
    if (count === 0) {
      throw new Error("embedTempBrain staged no vectors: the embedding pass wrote nothing");
    }

    // Readers open this file on their own connection — a spawned bin, or a
    // bare one with no extension — so leave nothing behind in the WAL.
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    return count;
  } finally {
    db.close();
  }
}
