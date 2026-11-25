/** Host drivers need Docker; their payload containers still use --network=none. */
export const DOCKER_TEST_FILES = ["tests/workspace-lease.test.ts", "tests/browser-determinism-container.test.ts"] as const;
export function isDockerTest(file: string): boolean {
  return DOCKER_TEST_FILES.some(path => file.replaceAll("\\", "/").endsWith(`/${path}`) || file === path);
}
