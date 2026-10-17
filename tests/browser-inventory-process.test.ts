import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserInventory } from "../scripts/proof-inputs";

async function nativeControl(script: string) {
  const root = mkdtempSync(join(tmpdir(), "inventory-process-"));
  mkdirSync(join(root, "packages/ui-kit"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/visual.mjs"), 'const projects = projectArgs.length ? [] : ["visual"];\n');
  const original = Bun.spawn;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output = "";
  const spawn = spyOn(Bun, "spawn").mockImplementationOnce(((argv: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    output = argv.find(arg => arg.startsWith("--json="))!.slice(7);
    child = original(["node", "-e", script, output], options);
    return child;
  }) as typeof Bun.spawn);
  try {
    let result: unknown;
    try { result = await browserInventory(root); } catch (error) { result = error; }
    expect(child).toBeDefined();
    await child!.exited;
    expect(() => process.kill(child!.pid, 0)).toThrow();
    expect(existsSync(output)).toBe(false);
    return result;
  } finally {
    spawn.mockRestore();
    if (child?.exitCode === null && !child.signalCode) { child.kill("SIGKILL"); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}
function diagnostics(result: unknown) {
  expect(result).toBeInstanceOf(Error);
  const message = (result as Error).message;
  expect(message).toStartWith("Vitest file discovery failed: ");
  const payload = message.slice("Vitest file discovery failed: ".length).split("\n")[0]!;
  expect(payload, "failure must expose structured process identity").toStartWith("{");
  return { message, receipt: JSON.parse(payload) };
}
test("native discovery failure preserves bounded output, exit and unpublished identity", async () => {
  const { message, receipt } = diagnostics(await nativeControl('process.stdout.write("O".repeat(200000)+"stdout-end");process.stderr.write("E".repeat(200000)+"stderr-end");process.exitCode=7;'));
  expect(receipt).toMatchObject({ deadlineMs: 15000, timedOut: false, exitCode: 7, signal: null, inventory: { present: false }, stdout: { bytes: 200010 }, stderr: { bytes: 200010 } });
  expect(receipt.elapsedMs).toBeGreaterThan(0);
  expect(receipt.stdout.tail).toEndWith("stdout-end");
  expect(receipt.stderr.tail).toEndWith("stderr-end");
  expect(message.length).toBeLessThan(4000);
});
test("native watchdog reports already published inventory and reaps the delayed child", async () => {
  const { receipt } = diagnostics(await nativeControl('require("node:fs").writeFileSync(process.argv[1],"[]");setInterval(()=>{},1000);'));
  expect(receipt).toMatchObject({ deadlineMs: 15000, timedOut: true, signal: "SIGKILL", inventory: { present: true, bytes: 2, sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" } });
  expect(receipt.elapsedMs).toBeGreaterThanOrEqual(14900);
  expect(receipt.elapsedMs).toBeLessThan(25000);
});
test("native signal remains distinct from watchdog expiration", async () => {
  const { receipt } = diagnostics(await nativeControl('process.kill(process.pid,"SIGTERM");'));
  expect(receipt).toMatchObject({ deadlineMs: 15000, timedOut: false, signal: "SIGTERM", inventory: { present: false } });
});
test("successful native exits still reject missing, malformed and incomplete JSON inventories", async () => {
  for (const script of ['process.exitCode=0;', 'require("node:fs").writeFileSync(process.argv[1],"{broken");', 'require("node:fs").writeFileSync(process.argv[1],"[]");']) {
    const { receipt } = diagnostics(await nativeControl(script));
    expect(receipt).toMatchObject({ exitCode: 0, timedOut: false, signal: null });
  }
});

test("native discovery receives the supported telemetry opt-out and preserves complete valid inventory", async () => {
  const kill = spyOn(process, "kill");
  try {
    const result = await nativeControl(`
      if(process.env.STORYBOOK_DISABLE_TELEMETRY!=="1")process.exit(8);
      const path=require("node:path"), root=path.dirname(path.dirname(process.argv[1]));
      const rows=["visual","ui-react-layout","ui-react-endurance"].map(projectName=>({projectName,file:path.join(root,"packages/fixture.tsx")}));
      require("node:fs").writeFileSync(process.argv[1],JSON.stringify(rows));
      console.error("console warnings stay outside the JSON channel");
    `);
    expect(result).toEqual(["ui-react-endurance", "ui-react-layout", "visual"].map(project => ({project,file:"packages/fixture.tsx"})));
    expect(kill.mock.calls.filter(([pid]) => pid < 0)).toHaveLength(0);
  } finally { kill.mockRestore(); }
});

test("native watchdog bounds inherited pipes even after the discovery leader has exited", async () => {
  const { receipt } = diagnostics(await nativeControl(`
    require("node:fs").writeFileSync(process.argv[1],"[]");
    const child=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},18000)"],{stdio:["ignore",1,2]});
    process.stdout.write(String(child.pid));
    child.unref();
    process.exit(0);
  `));
  expect(receipt).toMatchObject({ deadlineMs: 15000, timedOut: true, exitCode: 0, signal: null, inventory: { present: true, bytes: 2 } });
  expect(receipt.elapsedMs).toBeGreaterThanOrEqual(14900);
  expect(receipt.elapsedMs).toBeLessThan(17000);
  const descendant = Number(receipt.stdout.tail);
  expect(descendant).toBeGreaterThan(0);
  let state = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    try { state = /^State:\s+(\w)/m.exec(readFileSync(`/proc/${descendant}/status`, "utf8"))?.[1] ?? ""; }
    catch { state = "gone"; }
    if (state === "gone" || state === "Z") break;
    await Bun.sleep(10);
  }
  expect(["gone", "Z"]).toContain(state); // An adopted zombie cannot retain descriptors or execute.
});
