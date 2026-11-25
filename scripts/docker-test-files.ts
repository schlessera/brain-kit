import { relative, resolve, sep } from "node:path";
/** Host drivers need Docker; their payload containers still use --network=none. */
export const DOCKER_TEST_FILES = ["tests/workspace-lease.test.ts", "tests/browser-determinism-container.test.ts"] as const;
export function isDockerTest(file: string, root = resolve(import.meta.dir, "..")): boolean {
  const path = relative(root, resolve(root, file)).split(sep).join("/");
  return DOCKER_TEST_FILES.some(driver => path === driver);
}
