/** Authored workload for #842; separate from its unchanged 24 regression goldens. */
import { document, TODAY, type Fixture } from "./fixture";

export type Workload = Fixture & { timezone: "UTC" | "Pacific/Honolulu" | "Pacific/Kiritimati"; category: string };
const note = (title: string, created: string, updated: string, body: string, extra = "") => document(title, created, updated, body, extra);
const date = (id: string, split: Fixture["split"], path: string, title: string, body: string, mtime: string, expectedDay: string, timezone: Workload["timezone"] = "UTC"): Workload => ({
  id, split, category: "date-order", timezone, mtime,
  files: { [path]: note(title, "2026-07-10", "2026-07-09", body) },
  expected: { [path]: note(title, expectedDay, expectedDay, body) },
});
const manual = (id: string, split: Fixture["split"], category: string, files: Record<string, string>): Workload => ({
  id, split, category, timezone: "UTC", files, expected: { ...files },
});

function table(id: string, split: Fixture["split"], directory: string, title: string, body: string, columns: string[]): Workload {
  const detail = `${directory}/detail.md`, index = `${directory}/_index.md`;
  const values = { Link: `[${title}](detail.md)`, Title: title, Status: "draft", Updated: "2026-07-03" };
  const row = (state: typeof values) => `| ${columns.map(key => state[key as keyof typeof values]).join(" | ")} |`;
  const heading = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n`;
  const before = `${body}\n\n${heading}${row(values)}\n\nThe council keeps this surrounding prose.`;
  const after = `${body}\n\n${heading}${row({ ...values, Status: "active", Updated: "2026-07-10" })}\n\nThe council keeps this surrounding prose.`;
  const detailText = note(title, "2026-07-01", "2026-07-10", body);
  return {
    id, split, category: "status-column", timezone: "UTC",
    files: { [index]: document(`${title} index`, "2026-07-01", "2026-07-01", before, "", "index"), [detail]: detailText },
    expected: { [index]: document(`${title} index`, "2026-07-01", TODAY, after, "", "index"), [detail]: detailText },
  };
}

const tuningTable = table("ogygia-raft-status", "tuning", "context/ogygia/raft", "Raft checks", "Odysseus checks the tied mast.", ["Link", "Status", "Updated", "Title"]);
// The shipped detector identifies a row by its first cell. The prototype
// requires that evidence to be the explicit link; these positives keep that
// supported grammar while varying the other columns and fictional documents.
// This split is entity coverage, not evidence of unseen-template generalization.
const ithacaTable = table("ithaca-loom-status", "held-out", "context/ithaca/loom", "Loom checks", "Penelope checks the loom threads.", ["Link", "Title", "Updated", "Status"]);
const pylosTable = table("pylos-council-status", "held-out", "context/pylos/council", "Council record", "Nestor keeps the council account.", ["Link", "Updated", "Status", "Title"]);
const spartaTable = table("sparta-visit-status", "held-out", "context/sparta/visit", "Visit notes", "Menelaus hosts Telemachus in Sparta.", ["Link", "Status", "Title", "Updated"]);
const ambiguousFiles = { ...tuningTable.files };
const ambiguousIndex = Object.keys(ambiguousFiles).find(path => path.endsWith("/_index.md"))!;
ambiguousFiles[ambiguousIndex] = ambiguousFiles[ambiguousIndex]!.replace("| Raft checks |", "| Unconfirmed raft title |");
const generatedFiles = { ...ithacaTable.files };
const generatedIndex = Object.keys(generatedFiles).find(path => path.endsWith("/_index.md"))!;
generatedFiles[generatedIndex] = generatedFiles[generatedIndex]!.replace("| Title |", "<!-- brain:generated:registry -->\n| Title |") + "\n<!-- /brain:generated:registry -->\n";
const archivedFiles = { ...pylosTable.files };
const archivedDetail = Object.keys(archivedFiles).find(path => path.endsWith("/detail.md"))!;
archivedFiles[archivedDetail] = archivedFiles[archivedDetail]!.replace("status: active", "status: archived");
const multipleFiles = { ...spartaTable.files };
const multipleIndex = Object.keys(multipleFiles).find(path => path.endsWith("/_index.md"))!;
multipleFiles[multipleIndex] = multipleFiles[multipleIndex]!.replace("| draft | Visit notes |", "| draft | Unconfirmed visit |");

export const workload: Workload[] = [
  date("ogygia-mtime-day", "tuning", "context/ogygia/mast.md", "Mast inspection", "Odysseus keeps the mast tied.", "2026-07-11T12:00:00Z", "2026-07-11"),
  date("ogygia-created-day", "tuning", "context/ogygia/rope.md", "Rope inspection", "Odysseus checks the rope.", "2026-07-08T12:00:00Z", "2026-07-10"),
  tuningTable,
  manual("ogygia-equal-days", "tuning", "equal-dates", { "context/ogygia/sail.md": note("Sail checks", "2026-07-10", "2026-07-10", "Odysseus inspects the sail.") }),
  manual("ogygia-ambiguous-title", "tuning", "multiple-columns", ambiguousFiles),
  manual("ogygia-inbox", "tuning", "excluded", { "notes/ogygia-capture.md": note("Raft thought", "2026-07-10", "2026-07-09", "Odysseus keeps an unprocessed thought.") }),
  date("ithaca-east-midnight", "held-out", "context/ithaca/thread.md", "Thread inspection", "Penelope retains the woven pattern.", "2026-07-12T00:30:00+14:00", "2026-07-11", "Pacific/Kiritimati"),
  date("pylos-west-midnight", "held-out", "context/pylos/tablet.md", "Tablet inspection", "Nestor retains the council record.", "2026-07-11T23:30:00-10:00", "2026-07-12", "Pacific/Honolulu"),
  ithacaTable, pylosTable, spartaTable,
  manual("ithaca-equal-days", "held-out", "equal-dates", { "context/ithaca/shuttle.md": note("Shuttle checks", "2026-07-11", "2026-07-11", "Penelope keeps the shuttle ready.") }),
  manual("pylos-invalid-calendar", "held-out", "invalid-date", { "context/pylos/account.md": note("Account date", "2026-02-30", "2026-02-01", "Nestor leaves this uncertain date for review.") }),
  manual("sparta-timestamp", "held-out", "unsupported-date", { "context/sparta/arrival.md": note("Arrival note", "2026-07-10T23:30:00-10:00", "2026-07-09", "Telemachus retains the recorded arrival time.") }),
  manual("ithaca-archived", "held-out", "excluded", { "context/ithaca/archived/thread.md": note("Archived thread", "2026-07-10", "2026-07-09", "Penelope keeps this archived record.") }),
  manual("ithaca-generated-table", "held-out", "generated-ownership", generatedFiles),
  manual("pylos-archived-detail", "held-out", "excluded-detail", archivedFiles),
  manual("sparta-multiple-columns", "held-out", "multiple-columns", multipleFiles),
];
