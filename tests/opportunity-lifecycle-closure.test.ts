import { expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedClosure, closureDigest } from "../scripts/evals/opportunity-lifecycle/closure";

test("closure binds real executable and directory mode changes with identical file bytes", () => {
  const root = mkdtempSync(join(tmpdir(),"lifecycle-closure-"));
  try {
    writeFileSync(join(root,"fixture.txt"),"identical bytes"); chmodSync(join(root,"fixture.txt"),0o644);
    const before = ownedClosure(root); chmodSync(join(root,"fixture.txt"),0o755);
    const fileChanged = ownedClosure(root);
    expect(closureDigest(fileChanged)).not.toBe(closureDigest(before));
    expect(fileChanged["fixture.txt"]!.sha256).toBe(before["fixture.txt"]!.sha256);
    expect(fileChanged["fixture.txt"]!.mode & 0o777).toBe(0o755);
    chmodSync(root,0o700); const dirBefore = ownedClosure(root); chmodSync(root,0o750);
    expect(closureDigest(ownedClosure(root))).not.toBe(closureDigest(dirBefore));
  } finally { rmSync(root,{ recursive: true, force: true }); }
});

test("closure resolves real retargeting and unchanged literal link target content changes", () => {
  const root = mkdtempSync(join(tmpdir(),"lifecycle-links-"));
  try {
    writeFileSync(join(root,"a.txt"),"same"); writeFileSync(join(root,"b.txt"),"same");
    symlinkSync("a.txt",join(root,"pointer")); const before = ownedClosure(root);
    unlinkSync(join(root,"pointer")); symlinkSync("b.txt",join(root,"pointer"));
    const retargeted = ownedClosure(root);
    expect(retargeted.pointer!.resolvedPath).toBe("b.txt");
    expect(retargeted.pointer!.resolvedIdentity!.inode).toBe(retargeted["b.txt"]!.inode);
    expect(closureDigest(retargeted)).not.toBe(closureDigest(before));
    const mtime = Number(BigInt(retargeted["b.txt"]!.mtimeNs)) / 1e9;
    writeFileSync(join(root,"b.txt"),"more"); utimesSync(join(root,"b.txt"),mtime,mtime);
    const modified = ownedClosure(root);
    expect(modified.pointer!.literalTarget).toBe(retargeted.pointer!.literalTarget);
    expect(modified.pointer!.resolvedIdentity!.sha256).not.toBe(retargeted.pointer!.resolvedIdentity!.sha256);
    expect(modified.pointer!.targetClosureSHA256).not.toBe(retargeted.pointer!.targetClosureSHA256);
    expect(closureDigest(modified)).not.toBe(closureDigest(retargeted));
  } finally { rmSync(root,{ recursive: true, force: true }); }
});

test("closure rejects an actual link outside owned roots before reading external bytes", () => {
  const parent = mkdtempSync(join(tmpdir(),"lifecycle-scope-")), root = join(parent,"brain");
  mkdirSync(root);
  try { symlinkSync("../outside.txt",join(root,"pointer"));
    // Existing sibling prevents dangling-link failure from masking the scope check.
    const outside = join(root,"../outside.txt"); writeFileSync(outside,"external sentinel");
    try { expect(() => ownedClosure(root)).toThrow("link leaves owned tree"); }
    finally { rmSync(outside); }
  } finally { rmSync(parent,{ recursive: true, force: true }); }
});

test("closure refuses an actual shared outside inode and admits links wholly inside owned tree", () => {
  const parent = mkdtempSync(join(tmpdir(),"lifecycle-hardlink-")), root = join(parent,"brain"); mkdirSync(root);
  try {
    writeFileSync(join(root,"owned.txt"),"public fixture bytes");
    linkSync(join(root,"owned.txt"),join(parent,"outside.txt"));
    expect(() => ownedClosure(root)).toThrow("regular file shares inode outside owned tree");
    unlinkSync(join(parent,"outside.txt")); linkSync(join(root,"owned.txt"),join(root,"alias.txt"));
    const admitted = ownedClosure(root);
    expect(admitted["owned.txt"]!.links).toBe("2");
    expect(admitted["owned.txt"]!.inode).toBe(admitted["alias.txt"]!.inode);
  } finally { rmSync(parent,{ recursive: true, force: true }); }
});
