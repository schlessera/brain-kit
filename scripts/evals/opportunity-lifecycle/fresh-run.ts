/** Keyless candidate execution; this does not call, score or approve a live model. */
import { readFileSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { parseFrontmatter } from "../../../packages/core/src/lib/frontmatter-parse";
import { readGeneratedRegion, splitFrontmatterBlock } from "../../../packages/core/src/lib/generated-regions";
import { openDatabase } from "../../../packages/core/src/lib/db";
import { freshCases, referenceFiles, type FreshCase, type Checkpoint } from "./fresh-corpus";
import { createConfiguredLab, inspect, apply, type Lab } from "./prototype";
import { observe, differences, type Observation } from "./observation";
import { cli, successful } from "./cli";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ?
  Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => [key,canonical(item)])) : value;
const date = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null;
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
const text = (lab: Lab, path: string) => readFileSync(join(lab.root, path), "utf8");
const body = (raw: string) => splitFrontmatterBlock(raw).body;

/** Candidate-only format checks. Native scoring must use semantic review, not these private regions. */
export function assertCandidate(lab: Lab, fixture: FreshCase, expected: Checkpoint, before: Observation) {
  const prefix = `${fixture.directory}/${fixture.target}`, statusPath = `${prefix}/status.md`;
  const after = observe(lab.root), changes = differences(before, after);
  if (expected.clarify) { check(changes.length === 0, "clarification changed fixture files or metadata"); return; }
  const permitted = new Set([statusPath, `${prefix}/interview-prep.md`, fixture.focusPath, `${fixture.directory}/_index.md`,
    ...Object.keys(fixture.files).filter(path => path.startsWith(prefix + "/") && expected.stage.match(/^(offer|closed)$/))]);
  for (const changed of changes) {
    const directoryOnly = after[changed.path]?.kind === "directory" && changed.fields.every(field => field === "mtimeNs" || field === "size") &&
      [...permitted].some(path => path.startsWith(changed.path + "/"));
    check(permitted.has(changed.path) || directoryOnly, `unintended effect: ${changed.path} ${changed.fields.join(",")}`);
    if (permitted.has(changed.path)) {
      check(after[changed.path]?.kind === "file", `owned source kind changed: ${changed.path}`);
      check(!before[changed.path] || before[changed.path]!.mode === after[changed.path]!.mode, `owned source permissions changed: ${changed.path}`);
    }
  }
  const status = text(lab, statusPath), data = parseFrontmatter(status).data;
  check(data.stage === expected.stage, "status stage differs from independent checkpoint");
  check(date(data.deadline) === expected.deadline, "status deadline differs from independent checkpoint");
  check((data.next_step ?? null) === (expected.calls[0] ?? (expected.stage === "offer" ? expected.input.nextStep : null)), "status next step differs from independent checkpoint");
  check(expected.stage !== "closed" || data.closed_reason === expected.input.reason, "closure reason differs from confirmed fact");
  check(expected.stage !== "closed" || data.relevance === "historical", "closure relevance remains active");
  const ledger = readGeneratedRegion(body(status), "lifecycle-events")?.split("\n").map(line => JSON.parse(line));
  check(ledger?.length === expected.history.length, "event history cardinality is incorrect");
  check(JSON.stringify(ledger.map(event => event.id)) === JSON.stringify(expected.history), "event history is incomplete or duplicated");
  const confirmedInputs = fixture.checkpoints.filter(row => expected.history.includes(String(row.input.id))).map(row => row.input);
  check(JSON.stringify(canonical(ledger)) === JSON.stringify(canonical(confirmedInputs)), "retained confirmed event facts changed");
  const contacts = readGeneratedRegion(body(status), "lifecycle-contacts") ?? "";
  const contactRows = contacts.split("\n").filter(row => row.startsWith("| ") && !row.startsWith("| Name |") && !row.startsWith("| --- |"));
  check(contactRows.length === expected.contacts.length, "contact cardinality differs from independent checkpoint");
  for (const name of expected.contacts) check(contacts.split("\n").filter(row => row.startsWith(`| ${name} |`)).length === 1, `contact duplicated/missing: ${name}`);
  check(contacts.split("\n").filter(row => row.endsWith("| unknown; ask before outreach |")).length === expected.contacts.length, "invented or unrecorded contact details");
  const prepPath = `${prefix}/interview-prep.md`, prep = after[prepPath] ? text(lab, prepPath) : null;
  check((prep ? date(parseFrontmatter(prep).data.deadline) : null) === (expected.calls.length ? expected.deadline : null), "prep deadline differs from independent checkpoint");
  const calls = prep ? readGeneratedRegion(body(prep), "lifecycle-calls") ?? "" : "";
  for (const call of expected.calls) check(calls.includes(call), "missing independently expected active call");
  check(calls.split("\n").filter(row => row.startsWith("- [")).length === expected.calls.length, "active call cardinality differs");
  const focus = body(text(lab, fixture.focusPath));
  check(focus.includes("- Preserve the unrelated weaving priority."), "unrelated current-focus prose changed");
  const targetRows = focus.split("\n").filter(row => row.includes(`[[${prefix}/status]]`));
  check(targetRows.length === (expected.focus ? 1 : 0), "target focus entry duplicated or not retired");
  check(!expected.focus || targetRows[0]?.includes(expected.focus), "current-focus next step differs");
  check(!expected.calls.length || targetRows[0]?.includes(expected.calls[0]!), "current-focus concrete date/time/zone missing");
  for (const [path, original] of Object.entries(fixture.files)) {
    if (!permitted.has(path)) { check(after[path]?.sha256 === hash(original), `unowned complete file changed: ${path}`); continue; }
    if (path === fixture.focusPath) continue;
    check(body(text(lab, path)).includes(body(original)), `original complete prose changed: ${path}`);
    if ((expected.stage === "offer" || expected.stage === "closed") && path.startsWith(prefix + "/") && path !== statusPath)
      check(parseFrontmatter(text(lab, path)).data.deadline === undefined, "stale sibling deadline remains after offer/closure");
  }
}

export async function runFresh() {
  const rows: Record<string, unknown>[] = [];
  for (const fixture of freshCases) {
    const lab = await createConfiguredLab(fixture.files);
    try {
      // Non-Markdown, binary and link membership participate in every checkpoint/replay.
      writeFileSync(join(lab.root, "attachments/fixture.bin"), Uint8Array.from([0, 255, 195, 128]));
      symlinkSync("manifest.txt", join(lab.root, "attachments/pointer"));
      successful(await cli(lab, ["config", "check", "--json"]));
      for (const [ordinal, expected] of fixture.checkpoints.entries()) {
        const before = observe(lab.root), focusLine = text(lab, fixture.focusPath).split("\n").find(line => line.includes(`[[${fixture.directory}/${fixture.target}/status]]`)) ?? "";
        const started = performance.now(), inspection = inspect(lab, expected.input, focusLine);
        if (expected.clarify) check(inspection.outcome === "clarify", `ambiguous input admitted: ${fixture.id}`);
        else {
          check(inspection.outcome === "planned", `valid input refused: ${fixture.id}: ${inspection.outcome === "clarify" ? inspection.reason : ""}`);
          const result = apply(lab, inspection.plan, true); check(result.outcome === "applied", `candidate application failed: ${fixture.id}`);
        }
        assertCandidate(lab, fixture, expected, before);
        let deadlines: unknown[] | null = null, briefing: string | null = null, replay: string | null = null;
        const elapsedMs = performance.now() - started;
        if (!expected.clarify) {
          successful(await cli(lab, ["jobs", "pipeline", "--json"]));
          successful(await cli(lab, ["index", "--force"]));
          const db = openDatabase(join(lab.root, "brain.db"));
          try { deadlines = db.query("SELECT path,deadline FROM documents WHERE deadline IS NOT NULL ORDER BY path").all(); } finally { db.close(); }
          const expectedDeadlines: Array<{ path: string; deadline: string }> = [];
          if (expected.deadline) expectedDeadlines.push({ path: `${fixture.directory}/${fixture.target}/status.md`, deadline: expected.deadline });
          if (expected.calls.length && expected.deadline) expectedDeadlines.push({ path: `${fixture.directory}/${fixture.target}/interview-prep.md`, deadline: expected.deadline });
          // A supplied sibling deadline remains until explicit offer/closure retirement.
          if (fixture.id === "offer-sibling-retirement" && expected.stage === "interviewing") expectedDeadlines.push({ path: `${fixture.directory}/${fixture.target}/questions.md`, deadline: "2026-07-22" });
          check(JSON.stringify(deadlines) === JSON.stringify(expectedDeadlines.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), "actual rebuilt database has missed/stale deadlines");
          briefing = successful(await cli(lab, ["briefing"])).stdout;
          const upcoming = briefing.split("## Upcoming Deadlines\n")[1]?.split("\n## ")[0] ?? "";
          const actualUpcoming = upcoming.split("\n").filter(line => /^- \d{4}-\d{2}-\d{2} \|/.test(line)).map(line => {
            const [deadline,path] = line.slice(2).split(" | "); return { path,deadline };
          }).sort((a,b) => a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : 0);
          check(JSON.stringify(actualUpcoming) === JSON.stringify(expectedDeadlines), "actual briefing contains missed/stale deadlines");
          const replayBefore = observe(lab.root), repeat = inspect(lab, expected.input, focusLine);
          check(repeat.outcome === "planned", "exact replay refused");
          replay = apply(lab, repeat.plan, true).outcome;
          check(replay === "applied" && differences(replayBefore, observe(lab.root)).length === 0, "exact replay changed file bytes or metadata");
        }
        rows.push({ case: fixture.id, split: fixture.split, checkpoint: ordinal, outcome: inspection.outcome,
          proposedSemanticPass: true, replay, deadlines, briefing, candidateMutationMs: elapsedMs,
          verificationIncludingReplayMs: performance.now() - started, effects: differences(before, observe(lab.root)),
          referenceFiles: Object.fromEntries(Object.entries(referenceFiles(fixture, expected)).map(([path,raw]) => [path,hash(raw)])) });
      }
    } finally { lab.close(); }
  }
  return { measured: false, mode: "keyless candidate against independently authored proposed semantics", cases: freshCases.length,
    checkpoints: rows.length, currentSkill: "unmeasured", complementaryReview: "pending; no approval", rows };
}

if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination) throw new Error("explicit private/output path required");
  mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, JSON.stringify(await runFresh(), null, 2) + "\n");
}
