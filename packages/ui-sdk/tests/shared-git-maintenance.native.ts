/** Runtime consumer proof for freshly created documented shared Git metadata. */
import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { createHostBoundary } from "../../ui-server/src/brain/host-boundary.js";

export async function captureSharedGitMaintenance(brain: string, phase: "fresh" | "warm" | "strict") {
  const boundary = createHostBoundary({ brainPath: brain, dbPath: `/identity-server-private/shared-git-${phase}.db`,
    nativeManager: createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" }) });
  await boundary.prepare();
  expect(boundary.isolated(), "SHARED_GIT_REAL_HOST_BOUNDARY").toBe(true);
  const run = (program: string) => boundary.run({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, credentials: false, gate: "shared", purpose: `Odysseus shared Git ${phase}` });
  const ref = `refs/heads/odysseus-shared-${phase}`, content = `Odysseus shared Git ${phase}.\n`;
  expect(existsSync(`${brain}/.git/modules`), "GIT_MASK_SCAFFOLD_ORIGINALLY_ABSENT").toBe(false);
  const result = await run(`
    const fs = require("node:fs"), root=process.env.BRAIN_ROOT;
    process.umask(0o002);
    function git(args, input) {
      const p=Bun.spawnSync(["git",...args], {stdin:input === undefined ? "ignore" : Buffer.from(input),stdout:"pipe",stderr:"pipe"});
      if(p.exitCode) throw Error("SHARED_GIT_COMMAND_FAILED "+JSON.stringify({args,code:p.exitCode,stderr:p.stderr.toString()}));
      return p.stdout.toString().trim();
    }
    const scaffoldDenials={};
    for(const [name,action] of Object.entries({
      write:()=>fs.writeFileSync(root+"/.git/modules/hostile","Odysseus"),
      originalHooks:()=>fs.writeFileSync(root+"/.git/hooks/hostile","Odysseus"),
      originalInfo:()=>fs.writeFileSync(root+"/.git/info/hostile","Odysseus"),
      chmod:()=>fs.chmodSync(root+"/.git/modules",0o777),
      rename:()=>fs.renameSync(root+"/.git/modules",root+"/.git/moved-mask"),
      symlink:()=>fs.symlinkSync("../config",root+"/.git/modules/hostile"),
      hardlink:()=>fs.linkSync(root+"/.git/config",root+"/.git/modules/hostile"),
    })) {
      try {action();throw Error("GIT_MASK_SCAFFOLD_PAYLOAD_MUTATION_SUCCEEDED "+name);}
      catch(e) {if(!["EROFS","EBUSY","EXDEV"].includes(e.code))throw e;scaffoldDenials[name]=e.code;}
    }
    const helper=Bun.spawnSync(["git","config","--get","credential.helper"],{stdout:"pipe",stderr:"pipe"});
    if(helper.exitCode!==1 || helper.stdout.length) throw Error("HOST_GLOBAL_GIT_CREDENTIALS_VISIBLE");
    const hooks=git(["config","--get","core.hooksPath"]);
    if(hooks!=="/tmp/brain-maintenance-git/hooks")throw Error("HOST_GLOBAL_GIT_HOOKS_VISIBLE");
    let privateDenied=false;
    try {fs.readFileSync("/identity-server-private/.git-credentials");}
    catch(e) {if(!["EACCES","ENOENT"].includes(e.code))throw e;privateDenied=true;}
    if(!privateDenied)throw Error("HOST_GIT_CREDENTIAL_FILE_VISIBLE");
    const safe=git(["config","--get-all","safe.directory"]).split("\\n");
    if(!safe.length || safe.some(path=>![${JSON.stringify(brain)},root].includes(path)) || !safe.includes(root))throw Error("SHARED_GIT_EXACT_SAFE_DIRECTORY");
    const blob=git(["hash-object","-w","--stdin"],${JSON.stringify(content)});
    fs.writeFileSync(root+"/shared-git-proof.md",${JSON.stringify(content)});
    git(["add","--","shared-git-proof.md"]);
    const tree=git(["write-tree"]);
    // A real commit invokes the selected hooks; the host-only pre-commit exits 97.
    git(["-c","user.name=Odysseus","-c","user.email=odysseus@example.invalid","commit","-qm","Record the shared voyage"]);
    const commit=git(["-c","user.name=Odysseus","-c","user.email=odysseus@example.invalid","commit-tree",tree],"Record the Ithaca voyage\\n");
    git(["update-ref",${JSON.stringify(ref)},commit]);
    const staged=git(["show",":shared-git-proof.md"]), committed=git(["show",${JSON.stringify(ref + ':shared-git-proof.md')}]);
    if(staged!==${JSON.stringify(content.trim())} || committed!==staged)throw Error("SHARED_GIT_INDEX_REF_CONTENT");
    console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),blob,tree,commit,ref:${JSON.stringify(ref)},safe,hooks,privateDenied,globalCredentialAbsent:true,scaffoldDenials}));
  `);
  expect(result.exitCode, result.stderr).toBe(0);
  const actual = JSON.parse(result.stdout);
  expect(actual.uid, "SHARED_GIT_ACTUAL_WORKER_UID").toBe(21002);
  expect(actual.gid, "SHARED_GIT_ACTUAL_SHARED_GROUP").toBe(21001);
  for (const key of ["blob", "tree", "commit"]) expect(actual[key], `SHARED_GIT_ACTUAL_${key.toUpperCase()}_WRITTEN`).toMatch(/^[a-f0-9]{40,64}$/);
  expect(actual.scaffoldDenials, "GIT_MASK_SCAFFOLD_ACTUAL_PAYLOAD_WRITES_REFUSED").toMatchObject({ write: "EROFS", originalHooks: "EROFS", originalInfo: "EROFS", chmod: "EROFS", rename: "EBUSY", symlink: "EROFS" });
  expect(["EROFS", "EXDEV"]).toContain(actual.scaffoldDenials.hardlink);
  expect(existsSync(`${brain}/.git/modules`), "GIT_MASK_SCAFFOLD_NOT_PUBLISHED").toBe(false);
  const persisted = await run(`
    for(const args of [["cat-file","blob",${JSON.stringify(actual.blob)}],["show",":shared-git-proof.md"],["show",${JSON.stringify(ref + ':shared-git-proof.md')}]]) {
      const p=Bun.spawnSync(["git",...args],{stdout:"pipe",stderr:"pipe"});
      if(p.exitCode) {process.stderr.write(p.stderr);process.exit(p.exitCode);}
      if(p.stdout.toString()!==${JSON.stringify(content)})throw Error("SHARED_GIT_REOPENED_CONTENT_MISMATCH "+args[0]);
    }
    console.log("SHARED_GIT_OBJECT_INDEX_REF_REOPENED");
  `);
  expect(persisted.exitCode, persisted.stderr).toBe(0);
  expect(persisted.stdout, "SHARED_GIT_PUBLISHED_OBJECT_INDEX_REF_REOPENED").toBe("SHARED_GIT_OBJECT_INDEX_REF_REOPENED\n");
  expect(existsSync(`${brain}/.git/modules`), "GIT_MASK_SCAFFOLD_ABSENCE_SURVIVES_REOPEN").toBe(false);
  const version = await boundary.run({ argv: [`${brain}/node_modules/.bin/brain`, "--version"], env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    credentials: false, gate: "shared", purpose: `Odysseus shared Git CLI ${phase}` });
  expect(version.exitCode, version.stderr).toBe(0);
  const expected = JSON.parse(readFileSync(new URL("../../core/package.json", import.meta.url), "utf8")).version;
  expect(version.stdout.trim().replace(/^v/, ""), "SHARED_GIT_ACTUAL_INSTALLED_CLI_VERSION").toBe(expected);
  console.log(JSON.stringify({ actualDocumentedSharedGitConsumer: { phase, ...actual, published: true, cliVersion: version.stdout.trim() } }));
}
