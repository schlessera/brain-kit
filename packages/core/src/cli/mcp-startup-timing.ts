import { debuglog } from "node:util";

const log = debuglog("brain-mcp-startup");

/** Development diagnostic on stderr when NODE_DEBUG includes brain-mcp-startup. */
export function timeMcpStartup(phase: "context" | "import" | "database" | "moduleTools" | "vector" | "connect") {
  const start = performance.now();
  return () => log("phase %s %s", phase, performance.now() - start);
}

/**
 * The `static` phase: from process start to the first statement of the bin's
 * `main`, which is the cost of everything the bin imports statically.
 */
export function logMcpStaticPhase(mainStart: number): void {
  log("phase %s %s", "static", mainStart);
}
