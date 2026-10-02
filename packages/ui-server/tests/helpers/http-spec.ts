import { readFileSync } from "node:fs";

/** The single classified inventory; fixtures must be checked against it. */
export const httpSpecification = readFileSync(new URL("../../../../docs/http-api.md", import.meta.url), "utf8");
export const httpCoverageMatrix = readFileSync(new URL("../../../../docs/http-api-coverage.md", import.meta.url), "utf8");
export const documentedRoutes = httpSpecification
  .split("\n")
  .flatMap((line) => {
    const match = /^\| (GET|POST|PUT|DELETE) \| `([^`]+)`( \(conditional\))? \| ([SI]) \|/.exec(line);
    return match ? [{ method: match[1]!, path: match[2]!, conditional: Boolean(match[3]), classification: match[4]! }] : [];
  });
