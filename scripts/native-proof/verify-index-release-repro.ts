/** Verify a constructed native failure, separately from healthy qualification. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function requireFact(value: unknown, name: string): asserts value {
  if (!value) throw new Error(`NATIVE_INDEX_RELEASE_REPRO_${name}`);
}
const read = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const lines = (path: string): any[] => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));

export function verifyIndexReleaseReproduction(directory: string, exitCode: number) {
  requireFact(exitCode === 1, "EXPECTED_EXIT_ONE");
  const fixture: any[] = read(join(directory, "native-fixture.json"));
  const test = fixture.find(row => row.kind === "command" && row.argv?.[1] === "run" && row.argv?.[2] === "test");
  requireFact(test?.code === 1 && test.stderr.includes("error: NATIVE_AUTOMATIC_INDEX_COMPLETED: NativeBrainManagerError: Native manager outcome is unknown"), "EXACT_HOSTED_ASSERTION");
  requireFact(/\b2 pass\s+1 fail\b/.test(test.stderr), "ONLY_INTENDED_CASE_FAILED");
  const cleanup = fixture.at(-1);
  requireFact(cleanup?.kind === "cleanup" && cleanup.mounted === false && cleanup.attached === false && cleanup.loopCreated === false && cleanup.backingExists === false && cleanup.errors?.length === 0, "OWNED_CLEANUP");
  requireFact(fixture.some(row => row.kind === "parent-userns-quota" && row.unchanged === true) && read(join(directory, "runner-quota.json")).unchanged === true, "QUOTAS_UNCHANGED");
  const run = join(directory, "run"), lifetime = read(join(run, "index-descendant-lifetime.json")), pin = lifetime.pinned;
  requireFact(lifetime.truncated === false && pin?.closedReason === "native-sync-failed", "EXACT_HANDLE_CLOSED");
  const child = lifetime.records.find((row: any) => row.pid === pin.pid && row.mountNamespace === pin.namespace);
  requireFact(child?.deadObservedWallAt > pin.openedWallAt && child.deadObservedWallAt < pin.closedWallAt, "WORKER_DEAD_WHILE_NAMESPACE_RETAINED");
  const events = lines(join(run, "events.jsonl"));
  const failure = events.find(row => row.kind === "automatic_index_failed" && row.ordinal === 1);
  requireFact(failure?.error.includes("Native manager outcome is unknown") && events.some(row => row.kind === "automatic_index_finished" && row.ordinal === 2 && row.wallAt > failure.wallAt), "FAILED_FIRST_RECOVERED_SECOND");
  const candidates = readdirSync(join(run, "native-release")).filter(name => name.endsWith(".json")).map(name => read(join(run, "native-release", name)));
  const evidence = candidates.find(row => row.samples?.some((sample: any) => sample.namespaceReferences?.some((ref: any) => ref.fd === pin.fd && ref.namespace === pin.namespace)));
  requireFact(evidence?.code === 137 && evidence.samples.length === 4, "KILLED_SYNC_RETAINED");
  const owner = evidence.samples[0].namespaceReferences.find((ref: any) => ref.fd === pin.fd && ref.namespace === pin.namespace);
  requireFact(owner && evidence.samples.every((sample: any) => sample.namespaceReferences.some((ref: any) => ref.pid === owner.pid && ref.fd === pin.fd && ref.namespace === pin.namespace)
    && sample.references.length === 0 && sample.mounts.length === 0
    && !sample.processes.some((process: any) => process.mountNamespace?.value === pin.namespace)
    && sample.coverage.processesTruncated === false && sample.coverage.descriptorsTruncated === false
    && sample.coverage.referencesTruncated === false && sample.coverage.namespaceReferencesTruncated === false && sample.coverage.mountsTruncated === false), "NAMESPACE_ONLY_CORRELATION");
  requireFact(evidence.signals.some((signal: any) => signal.signal === "SIGKILL" && signal.abort?.reason === "AbortError: The connection was closed."), "CONNECTION_ABORT");
  const operations = lines(join(run, "native-operations.jsonl"));
  const sameRoot = operations.filter(row => row.stage === "end" && row.command?.join(" ") === `subvolume sync /brain-fixture ${evidence.root.rootId}`);
  requireFact(sameRoot.some(row => row.code === 137) && sameRoot.some(row => row.code === 0 && row.wallAt >= pin.closedWallAt), "SAME_ROOT_RECLAIMED_AFTER_CLOSE");
  return { version: 1, kind: "expected-automatic-index-failure", qualification: false, root: evidence.root,
    namespace: pin.namespace, ownerPid: owner.pid, descriptor: pin.fd, childPid: child.pid,
    childDeadWallAt: child.deadObservedWallAt, handleClosedWallAt: pin.closedWallAt,
    failedOrdinal: 1, recoveredOrdinal: 2, cleanup, sameRootSync: sameRoot };
}
