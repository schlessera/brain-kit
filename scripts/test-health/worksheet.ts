/**
 * The audit worksheet: what one cluster's audit found and did, in the shared
 * vocabulary of `catalog.ts`. The auditing agent writes a draft whose evidence
 * points at files that `mutate` and `measure` produced; `resolveWorksheet`
 * loads them and `validateWorksheet` refuses a fixed finding without the
 * evidence its action requires. Nobody reviews these changes by reading them,
 * so this check is the review.
 */
import { ACTIONS, LENS_IDS, LENS_VERDICTS, REDUCING_ACTIONS, STATUSES, requiredEvidence, smellById,
  type ActionId, type LensId, type LensVerdict, type StatusId } from "./catalog";

export interface MutationEvidence { verdict: string; test: string; patchSha256: string; expect: string }
export interface RunsEvidence { runs: number; failures: number; medianMs: number | null }
/** One original assertion and the test that still makes it after the change. */
export interface Obligation { claim: string; owner: string }

export interface Evidence<Ref> {
  mutation?: Ref extends true ? string : MutationEvidence;
  before?: Ref extends true ? string : RunsEvidence;
  after?: Ref extends true ? string : RunsEvidence;
  obligations?: Obligation[];
  issue?: number;
  /** Titles of the test declarations this finding removes, as `describe > title`. */
  removes?: string[];
  /** Executed cases this finding removes, when that differs from `removes` (a shortened table). */
  removedCases?: number;
  /** Tests this finding renames; a renamed test is not a removed one. */
  renames?: Array<{ from: string; to: string }>;
}

export interface Finding<Ref = false> {
  id: string;
  file: string;
  test?: string;
  line?: number;
  lens: LensId;
  smell: string;
  action: ActionId;
  status: StatusId;
  /** One sentence: what was wrong and what was done or why it was left. */
  note: string;
  evidence?: Evidence<Ref>;
}

export interface FileAudit { file: string; lenses: Record<LensId, LensVerdict> }

export interface Worksheet<Ref = false> {
  schemaVersion: 1;
  runId: string;
  cluster: number;
  seed: string;
  /** Files this cluster may change: one package, audited through every lens. */
  members: string[];
  /** Neighbours in other packages, read for overlap only and never changed here. */
  context: string[];
  audits: FileAudit[];
  findings: Finding<Ref>[];
  /** `measure` outputs from before and after the cluster's changes, relative to the run directory; required when a Bun test file changed. */
  measurements?: { before: string; after: string };
}

/** A draft names evidence files, relative to the run directory. */
export type DraftWorksheet = Worksheet<true>;

interface MeasureFile { files?: Array<{ file?: unknown; runs?: unknown; failures?: unknown; medianMs?: unknown }> }
interface ReceiptFile { verdict?: unknown; test?: unknown; patchSha256?: unknown; expect?: unknown }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function runsFor(measure: MeasureFile, file: string, label: string): RunsEvidence {
  const row = measure.files?.find(entry => entry.file === file);
  if (!row || typeof row.runs !== "number" || typeof row.failures !== "number") throw new Error(`${label}: no measurement of ${file}`);
  return { runs: row.runs, failures: row.failures, medianMs: typeof row.medianMs === "number" ? row.medianMs : null };
}

/** Loads the evidence files a draft names. `readJson` receives the path as written. */
export function resolveWorksheet(draft: DraftWorksheet, readJson: (path: string) => unknown): Worksheet {
  if (!isObject(draft) || !Array.isArray(draft.findings)) throw new Error("A worksheet needs a findings array");
  const findings = draft.findings.map((finding): Finding => {
    const { evidence, ...rest } = finding;
    if (evidence === undefined) return rest;
    if (!isObject(evidence as unknown)) throw new Error(`${finding.id}: evidence must be an object`);
    const resolved: Evidence<false> = {};
    if (evidence.mutation !== undefined) {
      const receipt = readJson(evidence.mutation) as ReceiptFile;
      if (!isObject(receipt) || !text(receipt.verdict) || !text(receipt.test) || !text(receipt.patchSha256) || typeof receipt.expect !== "string") {
        throw new Error(`${finding.id}: ${evidence.mutation} is not a mutation receipt`);
      }
      resolved.mutation = { verdict: receipt.verdict, test: receipt.test, patchSha256: receipt.patchSha256, expect: receipt.expect };
    }
    for (const side of ["before", "after"] as const) {
      const path = evidence[side];
      if (path !== undefined) resolved[side] = runsFor(readJson(path) as MeasureFile, finding.file, `${finding.id} ${side}`);
    }
    if (evidence.obligations !== undefined) resolved.obligations = evidence.obligations;
    if (evidence.issue !== undefined) resolved.issue = evidence.issue;
    if (evidence.removes !== undefined) resolved.removes = evidence.removes;
    if (evidence.removedCases !== undefined) resolved.removedCases = evidence.removedCases;
    if (evidence.renames !== undefined) resolved.renames = evidence.renames;
    return { ...rest, evidence: resolved };
  });
  return { ...draft, findings };
}

export interface ValidateOptions { stableRuns: number }

/** Every problem found; an empty list means the worksheet may be recorded. */
export function validateWorksheet(sheet: Worksheet, options: ValidateOptions): string[] {
  const problems: string[] = [];
  if (!isObject(sheet)) return ["The worksheet is not an object"];
  if (sheet.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (!text(sheet.runId)) problems.push("runId is missing");
  if (!Number.isInteger(sheet.cluster) || sheet.cluster < 0) problems.push("cluster must be a non-negative integer");
  const members = Array.isArray(sheet.members) ? sheet.members : [];
  const context = Array.isArray(sheet.context) ? sheet.context : [];
  if (!members.length || new Set(members).size !== members.length) problems.push("members must be a non-empty list without duplicates");
  if (!members.includes(sheet.seed)) problems.push("seed must be one of the members");
  for (const file of context) if (members.includes(file)) problems.push(`${file} is both a member and context`);

  const audits = Array.isArray(sheet.audits) ? sheet.audits : [];
  const audited = new Map<string, FileAudit>();
  for (const audit of audits) {
    if (!isObject(audit) || !text(audit.file) || !isObject(audit.lenses)) { problems.push("An audit needs a file and a lenses object"); continue; }
    if (!members.includes(audit.file)) problems.push(`${audit.file}: only members are audited`);
    if (audited.has(audit.file)) problems.push(`${audit.file}: audited twice`);
    audited.set(audit.file, audit);
    for (const lens of LENS_IDS) {
      if (!LENS_VERDICTS.includes(audit.lenses[lens])) problems.push(`${audit.file}: lens ${lens} needs one of ${LENS_VERDICTS.join(", ")}`);
    }
    for (const lens of Object.keys(audit.lenses)) if (!LENS_IDS.includes(lens as LensId)) problems.push(`${audit.file}: unknown lens ${lens}`);
  }
  for (const file of members) if (!audited.has(file)) problems.push(`${file}: a member without an audit`);

  const findings = Array.isArray(sheet.findings) ? sheet.findings : [];
  const ids = new Set<string>();
  const open = new Map<string, number>();
  for (const finding of findings) {
    if (!isObject(finding) || !text(finding.id)) { problems.push("A finding needs an id"); continue; }
    const at = `finding ${finding.id}`;
    if (ids.has(finding.id)) problems.push(`${at}: duplicate id`);
    ids.add(finding.id);
    const member = members.includes(finding.file);
    if (!member && !context.includes(finding.file)) problems.push(`${at}: ${String(finding.file)} is not in this cluster`);
    const known = smellById(finding.smell);
    if (!LENS_IDS.includes(finding.lens)) problems.push(`${at}: unknown lens ${String(finding.lens)}`);
    if (!known) problems.push(`${at}: unknown smell ${String(finding.smell)}`);
    else if (known.lens !== finding.lens) problems.push(`${at}: smell ${finding.smell} belongs to lens ${known.lens}`);
    if (!ACTIONS.includes(finding.action)) problems.push(`${at}: unknown action ${String(finding.action)}`);
    if (!STATUSES.includes(finding.status)) problems.push(`${at}: unknown status ${String(finding.status)}`);
    if (!text(finding.note)) problems.push(`${at}: a note is required`);
    if (finding.status !== "accepted") open.set(`${finding.file}\n${finding.lens}`, (open.get(`${finding.file}\n${finding.lens}`) ?? 0) + 1);

    const evidence: Evidence<false> = isObject(finding.evidence) ? finding.evidence : {};
    if (finding.action === "none" && finding.status !== "accepted") problems.push(`${at}: action none goes with status accepted`);
    const reducing = REDUCING_ACTIONS.includes(finding.action);
    if (evidence.removes !== undefined && (!Array.isArray(evidence.removes) || evidence.removes.some(title => !text(title)))) problems.push(`${at}: removes is a list of test titles`);
    if (evidence.renames !== undefined && (!Array.isArray(evidence.renames) || evidence.renames.some(entry => !isObject(entry) || !text(entry.from) || !text(entry.to)))) {
      problems.push(`${at}: renames is a list of { from, to } titles`);
    }
    if (evidence.removedCases !== undefined && (!Number.isInteger(evidence.removedCases) || evidence.removedCases < 0)) problems.push(`${at}: removedCases is a whole number`);
    if ((evidence.removes?.length || evidence.removedCases) && !(finding.status === "fixed" && reducing)) {
      problems.push(`${at}: only a fixed remove, merge or move-tier finding may declare removed tests`);
    }
    if (evidence.renames?.length && finding.status !== "fixed") problems.push(`${at}: only a fixed finding renames a test`);
    if (finding.status === "filed") {
      if (finding.action !== "file-issue") problems.push(`${at}: status filed goes with action file-issue`);
      if (!Number.isInteger(evidence.issue) || (evidence.issue ?? 0) <= 0) problems.push(`${at}: a filed finding names its issue number`);
    }
    if (finding.status !== "fixed") continue;
    if (!member) problems.push(`${at}: a context file is read-only; defer the finding to its own package`);
    if (finding.action === "file-issue" || finding.action === "none") { problems.push(`${at}: action ${finding.action} cannot be fixed`); continue; }
    if (reducing && !evidence.removes?.length && !evidence.removedCases) {
      problems.push(`${at}: names the tests it removes (evidence.removes), or how many executed cases it removes (evidence.removedCases)`);
    }
    for (const kind of requiredEvidence(finding.lens, finding.action)) {
      if (kind === "mutation") {
        const mutation = evidence.mutation;
        if (!mutation) problems.push(`${at}: needs a mutation receipt`);
        else {
          if (mutation.verdict !== "killed") problems.push(`${at}: the mutation was not killed (${mutation.verdict})`);
          const owners = REDUCING_ACTIONS.includes(finding.action) ? [...members, ...context] : [finding.file];
          if (!owners.includes(mutation.test)) problems.push(`${at}: the mutation receipt is for ${mutation.test}`);
        }
      } else if (kind === "obligations") {
        const obligations = evidence.obligations;
        if (!Array.isArray(obligations) || !obligations.length) problems.push(`${at}: needs an obligation map`);
        else if (obligations.some(entry => !isObject(entry) || !text(entry.claim) || !text(entry.owner))) problems.push(`${at}: every obligation names a claim and its retained owner`);
      } else if (kind === "stable-runs") {
        const after = evidence.after;
        if (!after) problems.push(`${at}: needs an after measurement`);
        else if (after.runs < options.stableRuns || after.failures !== 0) problems.push(`${at}: needs ${options.stableRuns} clean runs after the change (${after.failures} failed of ${after.runs})`);
      } else if (kind === "faster") {
        const { before, after } = evidence;
        if (!before || !after || before.medianMs === null || after.medianMs === null) problems.push(`${at}: needs before and after timings`);
        else if (before.failures !== 0 || after.failures !== 0) problems.push(`${at}: timings from failing runs prove nothing`);
        else if (after.medianMs >= before.medianMs) problems.push(`${at}: not faster (${before.medianMs} ms before, ${after.medianMs} ms after)`);
      } else if (kind === "runs") {
        const after = evidence.after;
        if (!after || after.runs < 1 || after.failures !== 0) problems.push(`${at}: needs a passing run after the change`);
      }
    }
  }

  for (const [file, audit] of audited) {
    if (!isObject(audit.lenses)) continue;
    for (const lens of LENS_IDS) {
      const count = open.get(`${file}\n${lens}`) ?? 0;
      const verdict = audit.lenses[lens];
      if (verdict === "findings" && count === 0) problems.push(`${file}: lens ${lens} says findings but lists none`);
      if (verdict !== "findings" && count > 0) problems.push(`${file}: lens ${lens} says ${String(verdict)} but has ${count} finding(s)`);
    }
  }
  return problems;
}
