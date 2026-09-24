import { cleanScratch, pruneScratch, SCRATCH_DIR, type ScratchReport } from "../../lib/scratch.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain scratch <clean|prune> — the brain's scratch area (${SCRATCH_DIR}/)

Transient output (renders, image drafts) lands in the scratch area: inside the
brain so the UI can open it, gitignored so it is never committed, and pruned so
it cannot grow without bound. Move a file out of it to keep it.

  clean    Remove everything in the scratch area.
  prune    Remove files older than 7 days, then the oldest until it is under
           1 GB. Every write into scratch already does this, \`brain maintain\`
           does it as its last step, and the chat server runs it hourly. A
           brain with no chat server has no other periodic pass: schedule
           \`brain maintain\` (cron), or nothing prunes between writes.

Both refuse a \`.brain\` or \`.brain/scratch\` that is a symlink: nothing is
removed anywhere a link points.

--json envelope: { action, removed: [{ path, bytes, reason }], bytes, files }`;

export const scratchCommand: CoreCommand = {
  summary: "Clean or prune the brain's scratch area",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos } = parseArgs(args);
    const action = pos[0];
    if (action !== "clean" && action !== "prune") {
      throw new UsageError("Usage: brain scratch <clean|prune>");
    }
    const report: ScratchReport = action === "clean" ? cleanScratch(cli.brain.root) : pruneScratch(cli.brain.root);
    const freed = report.removed.reduce((sum, r) => sum + r.bytes, 0);
    emit(cli.json, { action, ...report }, () => {
      console.log(
        `${action === "clean" ? "Cleaned" : "Pruned"} ${SCRATCH_DIR}/: removed ${report.removed.length} file(s), ` +
          `${freed} bytes; ${report.files} file(s), ${report.bytes} bytes left.`,
      );
    });
  },
};
