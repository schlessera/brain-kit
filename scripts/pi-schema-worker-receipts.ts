/** Private measurement transport; production workers never import this module. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PI_SCHEMA_REQUEST_LIMIT } from "./pi-schema-measurement.ts";

const prefix = "__pi_schema_receipts__:";
const files = ["physical-requests.json", "billing-state.json", "tool-admission.jsonl", "replay-events.jsonl",
  ...Array.from({ length: PI_SCHEMA_REQUEST_LIMIT }, (_, i) => i + 1).flatMap(i => [
    `physical-${i}.sse`, `physical-${i}.error-body`, `sentinel-${i}.sse`, `sentinel-${i}-wire-sha.txt`,
  ])];

export function measurementWorkerEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env)
    .filter((pair): pair is [string, string] => pair[0].startsWith("BRAIN_MEASURE_") && pair[1] !== undefined));
}

export function flushMeasurementFiles(): void {
  const out = process.env.BRAIN_MEASURE_PI_RECEIPTS!;
  const contents = Object.fromEntries(files.filter(name => existsSync(join(out, name)))
    .map(name => [name, readFileSync(join(out, name)).toString("base64")]));
  process.stdout.write(JSON.stringify({ type: "event", event: { type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: prefix + JSON.stringify(contents) } } }) + "\n");
}

export function acceptMeasurementFiles(event: any): boolean {
  const delta = event?.assistantMessageEvent?.delta;
  if (event?.type !== "message_update" || typeof delta !== "string" || !delta.startsWith(prefix)) return false;
  const contents = JSON.parse(delta.slice(prefix.length));
  // Paths come from this fixed inventory, never from worker-provided keys.
  for (const name of files) if (typeof contents[name] === "string") {
    const target = name === "billing-state.json" && process.env.BRAIN_MEASURE_PI_BILLING_STATE
      ? process.env.BRAIN_MEASURE_PI_BILLING_STATE : join(process.env.BRAIN_MEASURE_PI_RECEIPTS!, name);
    writeFileSync(target, Buffer.from(contents[name], "base64"), { mode: 0o600 });
  }
  return true;
}
