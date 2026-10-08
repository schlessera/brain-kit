/** Produce complete author-provisional effects for independent review, never approval. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cycle, prepare } from "./fixture";
import { observeTree } from "./observer";
import { assessEffects, unchangedApproval, type EffectApproval } from "./effects";
import { workload } from "./workload";
import { hash, protocolSha } from "./protocol";

export async function effectCandidates(caseId?: string) {
  const rows = [];
  const selected = caseId ? workload.filter(f => f.id === caseId) : workload;
  if (!selected.length) throw Error("Unknown authored workload case");
  const workerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (caseId && selected[0].timezone !== workerTimezone) throw Error("Worker timezone differs from the authored case");
  for (const fixture of selected) {
    const env = prepare(fixture, 20 - Object.keys(fixture.files).length);
    try {
      const before = observeTree(env.root);
      await cycle(env, true);
      const dry = observeTree(env.root);
      const dryAssessment = assessEffects(before, dry, unchangedApproval(before));
      if (!dryAssessment.accepted) throw Error(`Dry-run changed ${fixture.id}`);
      const result = await cycle(env);
      const after = observeTree(env.root), expected: EffectApproval = unchangedApproval(before);
      for (const [path, bytes] of Object.entries(fixture.expected)) expected[path] = {
        bytesBase64: Buffer.from(bytes).toString("base64"), mode: before[path].mode,
        changed: fixture.files[path] !== bytes,
      };
      const logCandidates: Record<string, string> = {};
      for (const [path, entry] of Object.entries(after)) {
        if (!path.startsWith("context/hygiene/") || entry.kind !== "file") continue;
        const bytes = readFileSync(join(env.root, path));
        logCandidates[path] = bytes.toString("utf8");
        expected[path] = { bytesBase64: bytes.toString("base64"), mode: entry.mode, changed: true };
      }
      // Only the authored documents are independent expected values at this
      // stage. Every complete reconciler log candidate must be reviewed against
      // detection and policy before it can authorize a native write effect.
      const agreement = assessEffects(before, after, expected);
      if (!agreement.accepted) throw Error(JSON.stringify({ fixture: fixture.id, ...agreement }));
      await cycle(env);
      const repeat = observeTree(env.root);
      const repeatAssessment = assessEffects(after, repeat, unchangedApproval(after));
      if (!repeatAssessment.accepted) throw Error(`Repeat changed ${fixture.id}`);
      rows.push({ fixture: fixture.id, split: fixture.split, initialDocuments: 20,
        workerTimezone, expectedWorkerTimezone: fixture.timezone,
        timezoneRuntimeVerified: workerTimezone === fixture.timezone,
        authoredDocuments: fixture.files, expectedDocuments: fixture.expected,
        actualDetection: result.detection, actualAfterDetection: result.after,
        fullLogCandidates: logCandidates, expectedFiles: expected,
        before, dry, after, repeat, independentApproval: false });
    } finally { env.close(); }
  }
  return { protocolSha, workloadSha: hash(JSON.stringify(workload)),
    status: "author-provisional complete effects; complementary review required", rows };
}

if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination) throw Error("Require a protected output file for complete fixture effects");
  const result = await effectCandidates(process.argv[3]);
  writeFileSync(destination, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ protocolSha, rows: result.rows.length, independentApproval: false }));
}
