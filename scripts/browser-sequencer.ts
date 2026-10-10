import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { balanceBrowserSpecs, readBrowserCosts } from "./browser-shards";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Vitest calls shard only for --shard; unsharded discovery/sort are unchanged. */
export class MeasuredBrowserSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const specs = files.map(file => {
      const project = file.project.name.replace(/ \(chromium\)$/, "");
      return { project, key: `${project}::${relative(ROOT, file.moduleId).replaceAll("\\", "/")}`, file };
    });
    const costs = readBrowserCosts();
    const partitions = balanceBrowserSpecs(specs, shard.count, costs);
    if (shard.index < 1 || shard.index > partitions.length) throw new Error("Invalid browser shard index");
    console.log(`Measured browser shard ${shard.index}/${shard.count}: ${partitions[shard.index - 1]!.length}/${files.length} specs; ${specs.filter(spec => spec.key in costs.seconds).length} recorded weights, ${specs.filter(spec => !(spec.key in costs.seconds)).length} positive defaults`);
    return partitions[shard.index - 1]!.map(spec => spec.file);
  }
}
