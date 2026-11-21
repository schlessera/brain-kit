/** Native UID proof for the production journal's checkout receipt path (#4297). */
import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import type { TurnJournal } from "../../packages/ui-server/src/brain/turn-journal.js";
import type { HostBoundary } from "../../packages/ui-server/src/brain/host-boundary.js";

export async function proveCodeChangeReceipts(app: { db: Database; wsHost: { journal?: TurnJournal; execution?: { boundary: HostBoundary } } }, note: (kind: string, data: object) => void): Promise<void> {
  const journal = app.wsHost.journal!, boundary = app.wsHost.execution!.boundary;
  const checkout = "workspaces/receipt-argo", turnId = "native-receipt-odysseus";
  const run = async (program: string) => {
    const result = await boundary.run({ credentials: false, gate: "shared", purpose: "native receipt proof", env: { PATH: "/usr/bin:/bin" },
      argv: ["/usr/bin/python3", "-I", "-S", "-c", program], timeoutMs: 60_000, outputAreas: [checkout, "notes/receipt-odysseus.md"] });
    expect(result.exitCode, result.stderr).toBe(0);
  };
  await run(String.raw`
import os, subprocess
root = os.path.join(os.environ["BRAIN_ROOT"], "workspaces/receipt-argo")
os.mkdir(root)
env = {"PATH":"/usr/bin:/bin", "HOME":"/nonexistent", "GIT_CONFIG_NOSYSTEM":"1", "GIT_CONFIG_GLOBAL":"/dev/null"}
def git(*args): subprocess.run(["git", "-C", root, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example"] + list(args), env=env, check=True)
for name, data in [("chart.md", "Ithaca\n"), ("lost.md", "Troy\n"), (".gitignore", "build/\n")]:
    with open(os.path.join(root, name), "w") as file: file.write(data)
git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "Set sail")
with open(os.path.join(os.environ["BRAIN_ROOT"], "notes/receipt-odysseus.md"), "w") as file: file.write("Ithaca\n")
`);
  await journal.begin(turnId, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null, workspaceReadOnly: false, workspacesWritable: true }, error => { throw error; });
  expect(journal.details("ithaca", turnId)?.codeChanges?.[0]?.state, "NATIVE_RECEIPT_DURABLE_BEFORE_WRITES").toBe("recording");
  await run(String.raw`
import os
root = os.path.join(os.environ["BRAIN_ROOT"], "workspaces/receipt-argo")
for name, data in [("chart.md", "Scheria\n"), ("raft.md", "The raft\n")]:
    with open(os.path.join(root, name), "w") as file: file.write(data)
os.unlink(os.path.join(root, "lost.md")); os.mkdir(os.path.join(root, "build"))
with open(os.path.join(root, "build/output.js"), "w") as file: file.write("generated\n")
with open(os.path.join(os.environ["BRAIN_ROOT"], "notes/receipt-odysseus.md"), "w") as file: file.write("Return to Ithaca\n")
`);
  await journal.observe(); await journal.finish(turnId);
  const details = journal.details("ithaca", turnId)!;
  expect(details.codeChanges, "NATIVE_ONE_CHECKOUT_RECEIPT").toHaveLength(1);
  expect(details.codeChanges![0], "NATIVE_CHECKOUT_ENDPOINT_DIFF").toMatchObject({ state: "complete", paths: [
    { path: "chart.md", kind: "modified", untracked: false }, { path: "lost.md", kind: "deleted", untracked: false }, { path: "raft.md", kind: "added", untracked: true },
  ] });
  expect(details.changes.map(change => change.path), "NATIVE_CODE_ROWS_RETIRED_NOTES_RETAINED").toEqual(["notes/receipt-odysseus.md"]);
  expect(details.changes[0]!.before?.hash, "NATIVE_NOTE_BEFORE_IMAGE_RETAINED").toBeString();
  expect(await journal.codePreview("ithaca", turnId, checkout), "NATIVE_OWNED_ENDPOINT_PREVIEW").toMatchObject({ inline: true, diff: expect.stringContaining("Scheria") });
  note("code-change-receipts", { turnId, receipt: details.codeChanges![0], notePaths: details.changes.map(change => change.path) });
}
