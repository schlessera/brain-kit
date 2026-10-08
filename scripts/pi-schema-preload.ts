import { plugin } from "bun";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { measurementForm, replaceExactly } from "./pi-schema-measurement.ts";
import { installPiSchemaCapture } from "./pi-schema-capture.ts";

measurementForm(process.env.BRAIN_MEASURE_PI_SCHEMA_FORM);
const OriginalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends OriginalWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error("Measurement permits only its loopback server socket.");
    super(url, protocols);
    this.addEventListener("message", event => {
      appendFileSync(resolve(process.env.BRAIN_MEASURE_PI_RECEIPTS!, "server-frames.jsonl"), String(event.data) + "\n", {mode:0o600});
    });
  }
};
const helper = JSON.stringify(new URL("./pi-schema-measurement.ts", import.meta.url).pathname);
plugin({
  name: "measure-pi-schema-and-native-auth",
  setup(build) {
    build.onLoad({ filter: /\/ui-backend-pi\/src\/(bridge-tools|session-runtime|session-resources)\.ts$/ }, ({ path }) => {
      let source = readFileSync(path, "utf8");
      if (path.endsWith("bridge-tools.ts")) {
        source = `import { measurementSchema } from ${helper};\nconst __measurementSchema = measurementSchema(process.env.BRAIN_MEASURE_PI_SCHEMA_FORM);\n` + source;
        source = replaceExactly(source, "parameters: toPiParameters(SHOW_BLOCK_INPUT_SCHEMA)", "parameters: toPiParameters(__measurementSchema)");
        source = replaceExactly(source, "handleShowBlock(SHOW_BLOCK_INPUT_SCHEMA.parse(input))", "handleShowBlock(__measurementSchema.parse(input))");
      } else if (path.endsWith("session-runtime.ts")) {
        source = `import { createMeasurementModelRuntime } from ${helper};\n` + source;
        source = replaceExactly(source, "await ModelRuntime.create()", "await createMeasurementModelRuntime()", 2);
      } else {
        source = `import { measurementFixtureGuard } from ${helper};\n` + source;
        source = replaceExactly(source, "SettingsManager.create(brainPath, agentDir)", 'SettingsManager.inMemory({ transport: "sse", compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 180000 } }, cacheWarming: "off", packages: [], extensions: [], skills: [], prompts: [], enableAnalytics: false, enableInstallTelemetry: false })');
        source = replaceExactly(source, "noExtensions: !loadExtensions,", "noExtensions: true, noSkills: true, noPromptTemplates: true,");
        source = replaceExactly(source, "extensionFactories: [", "extensionFactories: [measurementFixtureGuard(brainPath),");
      }
      return { contents: source, loader: "ts" };
    });
  },
});
installPiSchemaCapture();
