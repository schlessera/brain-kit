import { cleanScratch, pruneScratch, SCRATCH_DIR, type ScratchPruneReport } from "../../lib/scratch.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain scratch <clean|prune> — the brain's scratch area (${SCRATCH_DIR}/)

Transient output (renders, image drafts) lands in the scratch area: inside the
brain so the UI can open it, gitignored so it is never committed, and pruned so
it cannot grow without bound. Retained conversation links pin files; move other files out of it to keep them.

  clean    Remove everything in the scratch area.
  prune    Remove files older than 7 days, then the oldest until it is under
           1 GB. render, image and okf export do this after writing there,
           \`brain maintain\` does it as its last step, and the chat server
           runs it hourly. A
           brain with no chat server has no other periodic pass: schedule
           \`brain maintain\` (cron), or nothing prunes between writes.

prune reads .brain/scratch-pins/pins.json on server-managed brains.
--pins-file <path> reads an explicit snapshot too. Missing, invalid or incomplete
managed pin data suspends deletion (exit 2). Pinned files survive both passes;
over-cap pins are reported, never deleted. clean is an explicit deletion.

Both refuse a \`.brain\` or \`.brain/scratch\` that is a symlink: nothing is
removed anywhere a link points.

--json envelope: { action, removed: [{ path, bytes, reason }], failed: [{ path, reason }], bytes, files, pinned?: { files, bytes }, overageBytes?: number, pinError?: string }
Exits 2 when a file could not be removed (it is listed in failed); the report is printed either way.`;

export const scratchCommand: CoreCommand = {
  summary: "Clean or prune the brain's scratch area",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const action = pos[0];
    if (action !== "clean" && action !== "prune") {
      throw new UsageError("Usage: brain scratch <clean|prune>");
    }
    if (flags["pins-file"] !== undefined &&
        (action !== "prune" || typeof flags["pins-file"] !== "string" || !flags["pins-file"].trim())) {
      throw new UsageError("--pins-file requires a path and is only supported by scratch prune");
    }
    const report = action === "clean" ? cleanScratch(cli.brain.root) : pruneScratch(cli.brain.root, Date.now(), {
      ...(typeof flags["pins-file"] === "string" ? { pinsFile: flags["pins-file"] } : {}),
    });
    const prune = action === "prune" ? report as ScratchPruneReport : undefined;
    const freed = report.removed.reduce((sum, r) => sum + r.bytes, 0);
    emit(cli.json, { action, ...report }, () => {
      console.log(
        `${action === "clean" ? "Cleaned" : "Pruned"} ${SCRATCH_DIR}/: removed ${report.removed.length} file(s), ` +
          `${freed} bytes; ${report.files} file(s), ${report.bytes} bytes left.`,
      );
      if (prune) {
        console.log(`  pinned: ${prune.pinned.files} file(s), ${prune.pinned.bytes} bytes; overage: ${prune.overageBytes} bytes.`);
        if (prune.pinError) console.log(`  pruning suspended: ${prune.pinError}`);
      }
      for (const f of report.failed) console.log(`  could not remove ${f.path}: ${f.reason}`);
    });
    // A pass that left something it should have removed is a partial
    // failure: exit 2, the report printed all the same.
    return report.failed.length > 0 || prune?.pinError ? 2 : 0;
  },
};
