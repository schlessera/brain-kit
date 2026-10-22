/**
 * Host exec helpers inside real Pi workers (#1429). Real bubblewrap launches
 * of each worker view; only the worker program is an offline peer that runs
 * the real worker-local grep/bash tools with the serialized host exec.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import * as autonomous from "../src/autonomous-envelope.js";
import { openPiWorkerSession } from "../src/worker-session.js";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

const caps = { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false };
const restrictedTurn = { autonomous: { origin: "autonomous" as const, persistence: "none" as const, containment: "restricted" as const,
  allowedTools: [], systemPromptAppend: "Odysseus offline fixture." } };

/** A brain beside a private directory holding the helpers, an alias to one of them, and secrets next to both. */
function layout() {
  const root = mkdtempSync("/var/tmp/odysseus-host-exec-"), brain = join(root, "brain"), privateDir = join(root, "private");
  const helpers = join(privateDir, "helpers");
  mkdirSync(brain); mkdirSync(helpers, { recursive: true }); mkdirSync(join(privateDir, "links"));
  writeFileSync(join(brain, "voyage.md"), "The wine-dark sea\n");
  writeFileSync(join(helpers, "wrap"), '#!/bin/sh\nprintf \'%s\\n\' "$@" >> /tmp/odysseus-wrapper.log\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(join(helpers, "kill"), '#!/bin/sh\nprintf \'%s %s\\n\' "$1" "$2" >> /tmp/odysseus-killer.log\nexec /bin/kill -s "$2" -- "-$1"\n', { mode: 0o755 });
  writeFileSync(join(helpers, "penelope.txt"), "the shroud\n");
  writeFileSync(join(privateDir, "ithaca-secret.txt"), "the bow\n");
  symlinkSync("../helpers/wrap", join(privateDir, "links", "wrap"));
  return { root, brain, privateDir, helpers, wrapperAlias: join(privateDir, "links", "wrap"), killer: join(helpers, "kill") };
}

function saveEnv(names: string[]) {
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  return () => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; };
}

for (const profile of ["governed", "strict", "restricted"] as const) {
  test(`Pi ${profile} worker runs worker-local grep/bash through masked host helpers and cancels with the killer`, async () => {
    const fixture = layout();
    const { root, brain } = fixture;
    const view = profile !== "governed" ? createFixtureWorkerStartupView(brain) : undefined;
    const sandbox: worker.WorkerSandbox = { brain, profile, restricted: profile === "restricted", areas: [], scratchAliasesRemoved: [],
      maskPaths: [fixture.privateDir] };
    const restoreEnv = saveEnv(["ANTHROPIC_API_KEY", "PI_CODING_AGENT_DIR", "BRAIN_UI_EXEC_WRAPPER", "BRAIN_UI_EXEC_KILLER"]);
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    process.env.ANTHROPIC_API_KEY = "sk-odysseus-offline";
    process.env.BRAIN_UI_EXEC_WRAPPER = "/bin/false";
    const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
    const nativeLaunch = worker.launchAgentWorker;
    let child: worker.LaunchedWorker | undefined;
    const launch = spyOn(worker, "launchAgentWorker").mockImplementation(options => {
      child = nativeLaunch({ ...options, command: [process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/host-exec-worker.ts")] });
      return child;
    });
    let session: Awaited<ReturnType<typeof openPiWorkerSession>>["session"] | undefined;
    try {
      session = (await openPiWorkerSession({ brainPath: brain, model: "anthropic/claude-sonnet-4-6",
        exec: { wrapper: fixture.wrapperAlias, killer: fixture.killer } }, join(root, "sessions"), {
        workerSandbox: sandbox, workerStartupView: view, ...(profile === "restricted" ? restrictedTurn : {}), caps,
      })).session;
      const report = JSON.parse(session.model!.id);
      expect(report.error, "HOST_HELPER_VISIBLE_IN_WORKER").toBeUndefined();
      expect(report.grep).toContain("voyage.md:1:The wine-dark sea");
      expect(report.bash).toBe("Ithaca");
      const wrapped = report.wrapperLog.split("\n");
      expect(wrapped, "WORKER_TOOLS_USED_HOST_WRAPPER").toEqual(expect.arrayContaining(["-rInE", "wine-dark", "-lc", "echo Ithaca", "sleep 30"]));
      expect(report.cancel).toBe("AbortError");
      expect(report.killerLog, "WORKER_KILLER_CANCELLED_GROUP").toMatch(/^\d+ TERM\n$/);
      expect(report.cancelMs).toBeLessThan(10_000);
      expect({ helpers: report.helperEntries, private: report.privateEntries, sibling: report.siblingVisible }, "HELPER_SIBLINGS_STAY_MASKED")
        .toEqual({ helpers: ["kill", "wrap"], private: ["helpers", "links"], sibling: false });
    } finally {
      try {
        session?.dispose(); child?.kill("SIGKILL"); await child?.exited.catch(() => {});
        launch.mockRestore(); probe.mockRestore(); restoreEnv();
        await view?.cleanup();
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 30_000);
}

const refusals = [
  ["a directory wrapper", (f: ReturnType<typeof layout>) => ({ exec: { wrapper: f.helpers } }), /exec wrapper .* regular file/],
  ["a wrapper linked to a directory", (f: ReturnType<typeof layout>) => {
    symlinkSync(f.helpers, join(f.root, "helpers-link"));
    return { exec: { wrapper: join(f.root, "helpers-link") } };
  }, /exec wrapper .* regular file/],
  ["a directory killer", (f: ReturnType<typeof layout>) => ({ exec: { wrapper: f.wrapperAlias, killer: f.helpers } }), /exec killer .* regular file/],
  ["a killer linked to a directory", (f: ReturnType<typeof layout>) => {
    symlinkSync(f.privateDir, join(f.root, "private-link"));
    return { exec: { killer: join(f.root, "private-link") } };
  }, /exec killer .* regular file/],
  ["a relative ambient wrapper", () => { process.env.BRAIN_UI_EXEC_WRAPPER = "helpers/wrap"; return {}; }, /must be an absolute path/],
] as const;

for (const [name, configure, message] of refusals) for (const restricted of [false, true]) {
  test(`Pi ${restricted ? "restricted" : "ordinary"} session refuses ${name} before any relay or worker`, async () => {
    const fixture = layout();
    const restoreEnv = saveEnv(["ANTHROPIC_API_KEY", "PI_CODING_AGENT_DIR", "BRAIN_UI_EXEC_WRAPPER", "BRAIN_UI_EXEC_KILLER"]);
    process.env.PI_CODING_AGENT_DIR = join(fixture.root, "pi-agent");
    process.env.ANTHROPIC_API_KEY = "sk-odysseus-offline";
    delete process.env.BRAIN_UI_EXEC_WRAPPER; delete process.env.BRAIN_UI_EXEC_KILLER;
    const envelope = spyOn(autonomous, "piAutonomousEnvelope");
    const launch = spyOn(worker, "launchAgentWorker").mockImplementation(() => { throw new Error("worker launched"); });
    try {
      const options = configure(fixture);
      await expect(openPiWorkerSession({ brainPath: fixture.brain, model: "anthropic/claude-sonnet-4-6", ...options },
        join(fixture.root, "sessions"), {
          workerSandbox: { brain: fixture.brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
          ...(restricted ? restrictedTurn : {}), caps,
        })).rejects.toThrow(message);
      expect(envelope, "NO_RELAY_BEFORE_HELPER_REFUSAL").not.toHaveBeenCalled();
      expect(launch, "NO_WORKER_BEFORE_HELPER_REFUSAL").not.toHaveBeenCalled();
    } finally {
      envelope.mockRestore(); launch.mockRestore(); restoreEnv();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}
