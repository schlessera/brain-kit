import { Disclosure } from "@schlessera/brain-ui-kit";
import type { StorageGuidanceResponse, StoragePage, StorageSnapshot } from "@schlessera/brain-ui-sdk/protocol";
import { bytes, exactBytes } from "./storage-model.js";

/**
 * "About these numbers" (#4549 brief, item 3): every caveat the old pane
 * printed inline, in order — units, On disk vs file size, partial coverage,
 * omitted errors, the Find large files matching rules, maintenance scope and
 * the history's own rules. One paragraph each, at the 68ch measure.
 */
export function StorageAbout({
  snapshot,
  files,
  larger,
  validThreshold,
  guidance,
}: {
  snapshot: StorageSnapshot | null;
  files: StoragePage | null;
  larger: string;
  validThreshold: boolean;
  guidance: StorageGuidanceResponse | null;
}) {
  const paragraph = "max-w-[68ch]";
  return (
    <div className="text-xs [&>div>.bk-control]:min-h-11" data-storage-about="">
      <Disclosure label="About these numbers" icon="ledger">
        <p className={paragraph}>
          Sizes use decimal kB, MB and GB: 1 MB is 1,000,000 bytes. File details keep exact bytes.
        </p>
        <p className={paragraph}>
          On disk uses filesystem allocation, not exclusive or reclaimable bytes, so on disk is never space freed. Unknown
          allocation never falls back to file size.
          {snapshot ? ` Basis: ${snapshot.basis}.` : ""} Capacities are separate filesystem observations (statfs); they are never
          added together, quota headroom is unknown, and shared extents prevent attributing volume usage to stores. Memory
          (tmpfs) is not disk. Remote copies and unobserved host stores are not measured.
        </p>
        {snapshot && snapshot.coverage !== "complete" && (
          <p className={paragraph}>
            Partial evidence. Known subtotals are at least what was measured (≥); unknown stores are excluded from map area
            and listed as ? rows with their reason.
            {snapshot.omittedErrors > 0 ? ` ${snapshot.omittedErrors} additional errors omitted.` : ""}
          </p>
        )}
        <p className={paragraph}>
          Find large files matches the .pdf filename extension, case-insensitively; file contents are not used to identify
          PDFs. Larger than is strict: a file of exactly{" "}
          {validThreshold ? exactBytes(Number(larger) * 1_000_000) : "the entered limit"} does not match.
          {files
            ? ` Exact entry sum: ${exactBytes(files.fileLogicalTotal)}. Matching object union: ${bytes(files.totals.logical)} file size. Shared names may count separately in the entry sum.`
            : " Totals sum matching entries; shared names may count separately."}
        </p>
        <p className={paragraph}>
          Owner-supported actions only. Capacity provisioning may be needed when protected stores consume space. Prune scratch
          answers keeps the existing seven-day / 1.07 GB policy (1,073,741,824 bytes); pinned answers are kept. Packing, index
          rebuilds, retained removal, Undo and backups need headroom; owner preflight remains final. A measured change is
          unattributed: other writers can change available space at the same time.
        </p>
        <p className={paragraph}>
          The chart draws actual endpoints, never averages. The current bucket is provisional and gaps are not zeros; daily
          and weekly points are not interpolated, and weekly points do not supply scenarios. Each dashed line is one window's
          scenario, not a confidence interval or a deadline. Other writers can change capacity while App usage stays flat;
          shared extents may overlap, so a negative change is not proof of space reclaimed.
          {guidance?.scopeLimit || (guidance?.untracked.length ?? 0) > 0
            ? " History is limited to four capacity scopes and is not recorded for the others; inspect their current inventory instead."
            : ""}
        </p>
      </Disclosure>
    </div>
  );
}
