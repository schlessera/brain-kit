import { plugin } from "bun";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { measurementForm, nativeCredential, replaceExactly } from "./pi-schema-measurement.ts";

measurementForm(process.env.BRAIN_MEASURE_PI_SCHEMA_FORM);
nativeCredential();
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
const receipts = JSON.stringify(new URL("./pi-schema-worker-receipts.ts", import.meta.url).pathname);
const workerPreload = new URL("./pi-schema-worker-preload.ts", import.meta.url).pathname;
plugin({
  name: "measure-pi-schema-and-native-auth",
  setup(build) {
    build.onLoad({ filter: /\/ui-backend-pi\/src\/(bridge-tools|worker-session)\.ts$/ }, ({ path }) => {
      let source = readFileSync(path, "utf8");
      if (path.endsWith("bridge-tools.ts")) {
        source = `import { measurementSchema } from ${helper};\nconst __measurementSchema = measurementSchema(process.env.BRAIN_MEASURE_PI_SCHEMA_FORM);\n` + source;
        source = replaceExactly(source, "parameters: toPiParameters(SHOW_BLOCK_INPUT_SCHEMA)", "parameters: toPiParameters(__measurementSchema)");
        source = replaceExactly(source, "handleShowBlock(SHOW_BLOCK_INPUT_SCHEMA.parse(input))", "handleShowBlock(__measurementSchema.parse(input))");
      } else {
        source = `import { acceptMeasurementFiles, measurementWorkerEnv } from ${receipts};\n` + source;
        source = replaceExactly(source, 'command: [process.execPath,', `command: [process.execPath, "--preload", ${JSON.stringify(workerPreload)},`);
        source = replaceExactly(source, 'BRAIN_ROOT: backend.brainPath },', 'BRAIN_ROOT: backend.brainPath, ...measurementWorkerEnv() },');
        source = replaceExactly(source, 'if (msg.event.type === "tool_execution_end") {', 'if (acceptMeasurementFiles(msg.event)) continue;\n        if (msg.event.type === "tool_execution_end") {');
      }
      return { contents: source, loader: "ts" };
    });
  },
});
