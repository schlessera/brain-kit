/**
 * `reindexWithProviders`, the index step `maintain`, `doctor --fix` and `sync`
 * share (#4710): an index run that throws still closes the database handle
 * before the error reaches the caller.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import { indexDbPath } from "@schlessera/brain-common/internal/index-location";
import { reindexWithProviders } from "../src/cli/io.js";
import type { CliContext } from "../src/cli/types.js";
import { buildTaxonomy } from "../src/lib/taxonomy.js";
import type { EmbeddingProvider } from "../src/lib/seams.js";
import { cleanup, makeTempBrain } from "./cli-harness";

const temps: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  while (temps.length) cleanup(temps.pop()!);
});

/** A provider whose `embed` throws before it returns a promise, so the index run itself rejects. */
const throwingProvider: EmbeddingProvider = {
  id: "ithaca:throwing",
  dimensions: 8,
  embed() {
    throw new Error("the provider is unreachable");
  },
  embedQuery: async () => new Float32Array(8),
};

test("a failed index run closes the handle before the error reaches the caller", async () => {
  const root = realpathSync(makeTempBrain());
  temps.push(root);
  const dbPath = indexDbPath(root);
  const cli: CliContext = {
    brain: { root, dbPath, config: null, configPath: null, modules: [], taxonomy: buildTaxonomy({}) },
    json: true,
    embeddings: throwingProvider,
  };
  const closed: string[] = [];
  const original = Database.prototype.close;
  const close = spyOn(Database.prototype, "close").mockImplementation(function (this: Database, ...args: Parameters<Database["close"]>) {
    closed.push(this.filename);
    return original.apply(this, args);
  });
  restores.push(() => close.mockRestore());

  await expect(reindexWithProviders(cli)).rejects.toThrow("the provider is unreachable");
  expect(closed.filter((path) => path === dbPath)).toHaveLength(1);
});
