import { expect, test } from "bun:test";
import { resolve } from "node:path";

const entries = ["worker-sandbox", "maintenance-worker", "worker-launcher"] as const;
const orders = entries.flatMap(first => entries.filter(second => second !== first).map(second =>
  [first, second, entries.find(entry => entry !== first && entry !== second)!]));

for (const order of orders) test(`fresh worker imports initialize in order: ${order.join(" -> ")}`, async () => {
  const paths = order.map(entry => resolve(import.meta.dir, `../src/server/${entry}.ts`));
  const source = `const modules=new Map();
    for(const path of ${JSON.stringify(paths)})modules.set(path.split("/").at(-1),await import(path));
    const sandbox=modules.get("worker-sandbox.ts"), launcher=modules.get("worker-launcher.ts");
    console.log(JSON.stringify({home:sandbox.WORKER_XDG_HOME,worker:sandbox.WORKER_XDG_DIRS,maintenance:launcher.MAINTENANCE_XDG_DIRS}));`;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `FRESH_WORKER_ENTRY_ORDER_INITIALIZES:${order.join(",")}\n${err}`).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(JSON.parse(out)).toEqual({
      home: "/tmp/brain-worker-home",
      worker: { XDG_CONFIG_HOME: "/tmp/brain-worker-home/config", XDG_CACHE_HOME: "/tmp/brain-worker-home/cache", XDG_DATA_HOME: "/tmp/brain-worker-home/data" },
      maintenance: { XDG_CONFIG_HOME: "/tmp/brain-worker-home/config", XDG_CACHE_HOME: "/tmp/brain-worker-home/cache", XDG_DATA_HOME: "/tmp/brain-worker-home/data", XDG_STATE_HOME: "/tmp/brain-maintenance-state" },
    });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
