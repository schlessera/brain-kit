/** First-party measurement instrumentation, loaded AFTER the shared worker gate. */
import { plugin } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceExactly } from "./pi-schema-measurement.ts";

const out = join(process.env.BRAIN_WORKER_SCRATCH!, "measurement-receipts");
mkdirSync(out, { recursive: true, mode: 0o700 });
const priorBilling = process.env.BRAIN_MEASURE_PI_BILLING_STATE;
if (priorBilling && existsSync(priorBilling)) writeFileSync(join(out, "billing-state.json"), readFileSync(priorBilling));
process.env.BRAIN_MEASURE_PI_RECEIPTS = out;
process.env.BRAIN_MEASURE_PI_BILLING_STATE = join(out, "billing-state.json");
// The offline sentinel is installed before the observer and provider module.
if (process.env.BRAIN_MEASURE_PI_WORKER_OFFLINE === "1") await import("./pi-schema-offline-preload.ts");
const { installPiSchemaCapture } = await import("./pi-schema-capture.ts");
installPiSchemaCapture();
const helper = JSON.stringify(new URL("./pi-schema-measurement.ts", import.meta.url).pathname);
const capture = JSON.stringify(new URL("./pi-schema-capture.ts", import.meta.url).pathname);
const receipts = JSON.stringify(new URL("./pi-schema-worker-receipts.ts", import.meta.url).pathname);
plugin({ name: "measure-pi-native-worker", setup(build) {
  build.onLoad({ filter: /\/ui-backend-pi\/src\/(bridge-tools|native-session-runtime|session-resources|worker-entry)\.ts$/ }, ({ path }) => {
    let source = readFileSync(path, "utf8");
    if (path.endsWith("bridge-tools.ts")) {
      source = `import { measurementSchema } from ${helper};\nconst __measurementSchema = measurementSchema(process.env.BRAIN_MEASURE_PI_SCHEMA_FORM);\n` + source;
      source = replaceExactly(source, "parameters: toPiParameters(SHOW_BLOCK_INPUT_SCHEMA)", "parameters: toPiParameters(__measurementSchema)");
      source = replaceExactly(source, "handleShowBlock(SHOW_BLOCK_INPUT_SCHEMA.parse(input))", "handleShowBlock(__measurementSchema.parse(input))");
    } else if (path.endsWith("native-session-runtime.ts")) {
      source = `import { createMeasurementModelRuntime } from ${helper};\n` + source;
      source = replaceExactly(source, "await ModelRuntime.create(options.modelRuntimeOptions)", "await createMeasurementModelRuntime()", 2);
    } else if (path.endsWith("worker-entry.ts")) {
      source = `import { waitPiSchemaCaptures } from ${capture};\nimport { flushMeasurementFiles } from ${receipts};\n` + source;
      source = replaceExactly(source, "await syncAuth();", "await waitPiSchemaCaptures(); flushMeasurementFiles(); await syncAuth();", 2);
    } else {
      source = `import { measurementFixtureGuard } from ${helper};\n` + source;
      const start = source.indexOf("    const settingsManager = ");
      const end = source.indexOf("    const subagentTool =", start);
      if (start < 0 || end < 0) throw new Error("Measurement settings source anchor drift.");
      source = source.slice(0, start) + '    const settingsManager = SettingsManager.inMemory({ transport: "sse", compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 180000 } }, cacheWarming: "off", packages: [], extensions: [], skills: [], prompts: [], enableAnalytics: false, enableInstallTelemetry: false });\n' + source.slice(end);
      source = replaceExactly(source, "noExtensions: !loadExtensions,", "noExtensions: true, noSkills: true, noPromptTemplates: true,");
      source = replaceExactly(source, "extensionFactories: [", "extensionFactories: [measurementFixtureGuard(brainPath),");
    }
    return { contents: source, loader: "ts" };
  });
} });
