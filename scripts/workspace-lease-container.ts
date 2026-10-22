import { basename, dirname } from "node:path";

/** The lease fixture varies inside one checkout-owned Docker share. */
export function workspaceLeaseDockerArgs(root: string, image: string, user: string): string[] {
  return ["docker", "run", "--rm", "--pull=never", "--network=none", "--ipc=host",
    "--user", user, "-v", `${dirname(root)}:/repo`, "-w", `/repo/${basename(root)}`,
    image, "node", "scripts/visual.mjs", "--inside", "--project=visual"];
}
