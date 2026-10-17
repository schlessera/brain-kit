/** Compacts only this controller's successfully drained, removed capture states. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildNames, buildRead, checkBuildPrivateDirectory } from "./ci-build-files";
import { captureOutputs, digest, identity, outputFiles } from "./ci-build-boundary";
export function compactBuildEvidence(workspace: string, controller: string, result: any) {
  assert.equal(workspace, join(controller, "workspace")); checkBuildPrivateDirectory(controller);
  assert.equal(result.authority, "none"); assert(/^qualification(?:-|$)/.test(result.purpose));
  assert(result.drained === true && result.removed === true, "CI_BUILD_ONLY_REMOVED_SUCCESS_CAN_COMPACT");
  assert(/^[0-9a-f-]{36}$/.test(result.session));
  const state = result.artifactDirectory, suffix = relative(join(workspace, "tmp/isolated-ci-build"), state);
  assert(/^operation-[a-zA-Z0-9]+$/.test(suffix), "CI_BUILD_EVIDENCE_STATE_IS_CONTROLLER_OWNED"); checkBuildPrivateDirectory(state);
  const cleanup = JSON.parse(buildRead(join(state, "cleanup.json")).bytes.toString());
  assert(cleanup.session === result.session && cleanup.drained === true && cleanup.removed === true && /^[0-9a-f]{64}$/.test(cleanup.containerID), "CI_BUILD_COMPACTION_REQUIRES_CLEANUP_RECEIPT");
  const evidence = join(controller, "evidence", result.session); mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const files: {path: string; sha256: string; mode: number}[] = [];
  const retain = (path: string) => {
    const file = buildRead(join(state, path), undefined, 256 * 1024 * 1024), mode = Number(file.stat.mode & 0o7777n);
    mkdirSync(join(evidence, path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(join(evidence, path), file.bytes, { flag: "wx", mode }); chmodSync(join(evidence, path), mode);
    files.push({ path, sha256: digest(file.bytes), mode });
  };
  for (const path of ["invocation.json", "entry.json", "container-boundary.json", "cleanup.json", "diagnostics/isolated-producer.json"]) retain(path);
  for (const path of buildNames(join(state, "diagnostics"))) if (/^build-[0-9]+-[0-9a-f-]+-probe\.json$/.test(path) || path === "qualification-syscalls.log") retain(`diagnostics/${path}`);
  const bun = buildRead(join(state, "tool/bun")); assert.equal(digest(bun.bytes), result.producer.runtime.bun);
  const runtime = join(controller, "runtime"); mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const executable = join(runtime, `bun-${digest(bun.bytes)}`);
  if (!existsSync(executable)) writeFileSync(executable, bun.bytes, { flag: "wx", mode: 0o600 });
  assert.equal(digest(buildRead(executable).bytes), digest(bun.bytes));
  const outputs: Record<string, {identity: string; path: string}> = {};
  for (const [pkg, expected] of Object.entries(result.outputs ?? {})) {
    assert(/^[a-z0-9-]+$/.test(pkg) && typeof expected === "string" && /^[0-9a-f]{64}$/.test(expected));
    const destination = join(controller, "outputs", pkg, expected);
    if (!existsSync(destination)) { mkdirSync(join(destination, ".."), { recursive: true, mode: 0o700 }); assert.equal(identity(captureOutputs(join(state, "parents", pkg, "dist"), destination)), expected); }
    assert.equal(identity(outputFiles(destination)), expected, "CI_BUILD_COMPACTED_OUTPUT_BYTES_MATCH");
    outputs[pkg] = { identity: expected, path: relative(controller, destination) };
  }
  if (result.purpose === "qualification-consumers") for (const pkg of result.producer.consumers.packages) {
    assert(/^[a-z0-9-]+$/.test(pkg)); retain(`diagnostics/pack-work/brainkit-tarballs/${pkg}.tgz`);
  }
  const manifest = { version: 1, purpose: "qualification-evidence", authority: "none", session: result.session, key: result.key, originalCapture: state, files, outputs, bun: digest(bun.bytes), removedCapture: true };
  writeFileSync(join(evidence, "retained.writing.json"), JSON.stringify({ ...manifest, removedCapture: false }, null, 2), { flag: "wx", mode: 0o600 });
  // All consumers and publication have completed before this point. Failures
  // above retain the original state; only this exact owned capture is removed.
  const remove = (path: string) => { const stat = lstatSync(path); if (stat.isDirectory()) { chmodSync(path, (stat.mode & 0o777) | 0o700); for (const name of readdirSync(path)) remove(join(path, name)); } rmSync(path, { recursive: true }); };
  remove(state);
  writeFileSync(join(evidence, "retained.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  rmSync(join(evidence, "retained.writing.json"));
  return { artifactDirectory: evidence, originalArtifactDirectory: state, capturedStateRemoved: true, retainedIdentity: identity(manifest) };
}
