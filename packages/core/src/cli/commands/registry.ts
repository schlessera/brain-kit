import { runRegistry } from "../../lib/index-registry.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs } from "../io.js";

const HELP = `brain registry — regenerate _index.md registry tables from the children's frontmatter

An _index.md opts in with a \`registry:\` block in its frontmatter (columns,
optional where / sort / split). The table is written between
<!-- brain:generated:registry --> markers; the prose around it is kept, and
\`updated\` is bumped only on a file whose table changed.

  --check                 Write nothing; list out-of-date indexes (exit 1 if any)

--json: { indexes, written, stale, invalid: [{ path, error }] }`;

export const registryCommand: CoreCommand = {
  summary: "Regenerate _index.md registry tables from the children's frontmatter",
  helpBlock: HELP,
  async run(args, cli): Promise<number> {
    const { flags } = parseArgs(args);
    const check = flags.check === true;
    const result = runRegistry(cli.brain.root, cli.brain.taxonomy, {
      check,
      asOf: new Date().toISOString().slice(0, 10),
    });
    emit(cli.json, result, () => {
      if (result.indexes === 0) console.log("No _index.md opts in to a registry table.");
      for (const path of result.written) console.log(`  wrote  ${path}`);
      for (const path of result.stale) console.log(`  stale  ${path}`);
      for (const { path, error } of result.invalid) console.error(`  invalid registry in ${path}: ${error}`);
      if (result.indexes > 0 && result.written.length + result.stale.length + result.invalid.length === 0) {
        console.log(`All ${result.indexes} registry table(s) are current.`);
      }
    });
    if (result.invalid.length > 0) return check ? 1 : 2;
    return check && result.stale.length > 0 ? 1 : 0;
  },
};
