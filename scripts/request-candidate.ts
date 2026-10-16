/** Freeze an explicit native contributing-prefix request before the ready event. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText } from "./check-leakage";
import { freezeNativePrefix, nativeRequest, nativeRequestBody, verifyNativePrefix } from "./native-candidate";
import type { API } from "./proof-reuse";

function gh(...args: string[]): string {
  const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

if (import.meta.main) {
  let temporary: string | undefined;
  try {
    const args = process.argv.slice(2), verify = args[0] === "--verify";
    if (verify) args.shift();
    if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]!)) throw new Error("usage: bun scripts/request-candidate.ts [--verify] <native-pr-number>");
    const pr = Number(args[0]);
    if (!Number.isSafeInteger(pr)) throw new Error("Invalid PR number");
    const repository = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository identity");
    let requests = 0;
    const api: API = { async json(path) {
      if (++requests > 32) throw new Error("Native request API budget exceeded");
      return JSON.parse(gh("api", `repos/${repository}/${path}`));
    }, async log() { throw new Error("Unexpected log request"); } };
    const before = await api.json(`pulls/${pr}`);
    if (before.state !== "open" || !before.stack) throw new Error("An open native stacked PR is required");
    if (verify) {
      const prefix = await verifyNativePrefix({ pull_request: before }, { GITHUB_REPOSITORY: repository }, api);
      console.log(JSON.stringify({ verified: true, prefix }));
      process.exit(0);
    }
    if (!before.draft) gh("pr", "ready", String(pr), "--repo", repository, "--undo");
    const prefix = await freezeNativePrefix(repository, pr, api, true);
    const current = await api.json(`pulls/${pr}`);
    if (current.head?.sha !== prefix.members.at(-1)?.head || current.draft !== true) throw new Error("Candidate changed while freezing request");
    const body = nativeRequestBody(String(current.body ?? ""), prefix);
    if (scanText("body", body, { allowUploadImages: true }).length) throw new Error("Native request body failed the public leakage gate");
    temporary = mkdtempSync(join(tmpdir(), "odysseus-native-request-"));
    const file = join(temporary, "body.md"); writeFileSync(file, body);
    gh("pr", "edit", String(pr), "--repo", repository, "--body-file", file);
    // Verify a second authoritative snapshot before spending candidate proof.
    const checked = await freezeNativePrefix(repository, pr, api, true);
    if (JSON.stringify({ ...checked, request: prefix.request }) !== JSON.stringify(prefix) ||
        JSON.stringify(nativeRequest((await api.json(`pulls/${pr}`)).body)) !== JSON.stringify(prefix)) throw new Error("Native request became stale before confirmation");
    gh("pr", "ready", String(pr), "--repo", repository);
    console.log(JSON.stringify({ requested: true, prefix }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}
