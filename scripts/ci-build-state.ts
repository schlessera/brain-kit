/** Shared necessary reuse predicates; purpose never substitutes for qualification. */
import { identity, type BuildFile } from "./ci-build-boundary";
export type BuildPurpose = "production" | "qualification";
export const operationFor = (purpose: BuildPurpose) => purpose === "production" ? "fixed-isolated-ci-v1" : "fixed-isolated-ci-qualification-v1";
export type BuildMaterial = { producer: Record<string, string>; configuration: Record<string, string>; installation: string; bun: string };
export const buildProducerPaths = ["scripts/build.ts", "scripts/build-execution.ts", "scripts/build-receipt.ts", "scripts/build-repeat-observation.ts", "scripts/bin-modes.ts", "scripts/publishable-packages.ts", "scripts/workspace-lease.mjs",
  "scripts/ci-build-files.ts", "scripts/ci-build-lifetime.ts", "scripts/ci-build-context.ts", "scripts/ci-build-boundary.ts", "scripts/ci-build-operation.ts", "scripts/ci-build-entry.ts", "scripts/ci-build-state.ts", "scripts/ci-build-data.ts", "scripts/ci-build-trace.ts", "scripts/ci-build-consumers.ts", "scripts/ci-build-evidence.ts"];
const configuration = (entry: BuildFile) => !/(^|\/)node_modules(?:\/|$)/.test(entry.path) &&
  (/(^|\/)package\.json$/.test(entry.path) || /(^|\/)tsconfig[^/]*\.json$/.test(entry.path) || /(^|\/)bunfig\.toml$/.test(entry.path) || entry.path.endsWith(".css"));
export function buildMaterial(records: readonly BuildFile[], installation: string, bun: string): BuildMaterial {
  const byPath = new Map(records.map(entry => [entry.path, entry]));
  const producer = Object.fromEntries(buildProducerPaths.map(path => {
    const entry = byPath.get(path); if (entry?.kind !== "file") throw new Error("Missing fixed build producer");
    return [path, identity(entry)];
  }));
  return { producer, configuration: Object.fromEntries(records.filter(configuration).map(entry => [entry.path, identity(entry)])), installation, bun };
}
export function sameBuildMaterial(actual: BuildMaterial, expected: BuildMaterial): boolean {
  const sorted = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return actual.bun === expected.bun && actual.installation === expected.installation && identity(sorted(actual.producer)) === identity(sorted(expected.producer)) && identity(sorted(actual.configuration)) === identity(sorted(expected.configuration));
}
export function successfulBuildProducer(producer: any, selected: string[], node: {path: string; sha256: string | null}, bun: string): boolean {
  if (producer?.version !== 1 || producer.code !== 0 || producer.runtime?.bun !== bun || producer.runtime?.node?.path !== node.path ||
    (node.sha256 !== null && producer.runtime?.node?.sha256 !== node.sha256) || producer.topology !== "checked-after-child-exit" || producer.receipts?.length !== 1) return false;
  const receipt = producer.receipts[0]?.value;
  return receipt?.kind === "workspace-build" && receipt.state === "complete" && receipt.success === true && receipt.code === 0 &&
    Array.isArray(receipt.packages) && identity(receipt.packages.map((pkg: any) => pkg.name).sort()) === identity([...selected].sort()) &&
    receipt.packages.every((pkg: any) => pkg.state === "complete" && Array.isArray(pkg.children) &&
      pkg.children.length === (["ui-kit", "ui-react"].includes(pkg.name) ? 2 : 1) &&
      pkg.children.filter((child: any) => child.compiler === "tsc" && child.code === 0).length === 1 &&
      pkg.children.filter((child: any) => child.compiler === "css" && child.code === 0).length === (["ui-kit", "ui-react"].includes(pkg.name) ? 1 : 0));
}
/** Pure necessary predicate; production's complete policy and current outputs remain mandatory. */
export function matchingBuildReceipt(stamp: any, prior: any, receiptHash: string, expected: { purpose: BuildPurpose; domain: string; key: string; image: string; pkg: string; node: {path: string; sha256: string | null}; bun: string }): boolean {
  const operation = operationFor(expected.purpose);
  return stamp?.version === 1 && stamp.purpose === expected.purpose && stamp.domain === expected.domain && stamp.operation === operation && stamp.key === expected.key &&
    /^[0-9a-f-]{36}$/.test(stamp.producerSession) && stamp.receipt === receiptHash && prior?.version === 1 && prior.purpose === expected.purpose && prior.domain === expected.domain && prior.operation === operation &&
    prior.session === stamp.producerSession && prior.key === expected.key && prior.image === expected.image && prior.drained === true && prior.removed === true &&
    Array.isArray(prior.compiled) && prior.compiled.includes(expected.pkg) && prior.outputs?.[expected.pkg] === stamp.output &&
    successfulBuildProducer(prior.producer, prior.compiled, expected.node, expected.bun);
}
