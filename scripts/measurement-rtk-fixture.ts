/** Private installed-native oracle for the production enforcement measurement. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Re-enter a disposable system view; never install an oracle on the host. */
export async function enterMeasurementRtkView(): Promise<void> {
  if (process.argv.includes("--native-rtk-view")) return;
  const root = resolve(import.meta.dir, "..");
  mkdirSync(join(root, "tmp"), { recursive: true });
  const fixture = mkdtempSync(join(root, "tmp/enforcement-rtk-"));
  try {
    const source = join(fixture, "rtk.c"), binary = join(fixture, "rtk");
    // The first occurrence is the command's write target. Its later witness
    // inventory must stay unchanged, so it independently observes both files.
    writeFileSync(source, `#include <stdio.h>
#include <string.h>
int main(int argc,char **argv) {
  if(argc==2 && !strcmp(argv[1],"--version")){puts("Odysseus native RTK fixture");return 0;}
  if(argc!=3 || strcmp(argv[1],"hook") || strcmp(argv[2],"claude"))return 2;
  static char input[1048577]; size_t n=fread(input,1,sizeof(input)-1,stdin);
  if(ferror(stdin)||!feof(stdin))return 3; input[n]=0;
  char *body=strstr(input,"\\\"tool_input\\\":");
  if(!body || n<2 || input[n-1]!='}')return 4;
  body+=strlen("\\\"tool_input\\\":"); input[n-1]=0;
  char *target=strstr(body,"/tmp/brain-worker-scratch/original"); if(!target)return 5;
  fputs("{\\\"hookSpecificOutput\\\":{\\\"updatedInput\\\":",stdout);
  fwrite(body,1,target-body,stdout); fputs("/tmp/brain-worker-scratch/rewritten",stdout);
  fputs(target+strlen("/tmp/brain-worker-scratch/original"),stdout); puts("}}"); return 0;
}
`);
    const build = Bun.spawnSync(["cc", "-static-pie", "-o", binary, source], { stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`Native RTK fixture compilation failed: ${build.stderr.toString()}`);
    const child = Bun.spawn(["bwrap", "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-pid",
      "--cap-add", "CAP_SETUID", "--cap-add", "CAP_SETGID", "--cap-add", "CAP_SYS_ADMIN", "--cap-add", "CAP_SETFCAP",
      "--die-with-parent", "--new-session", "--tmpfs", "/",
      ...["/usr/bin", "/usr/lib", "/usr/lib64", "/usr/share", "/etc"].flatMap(path => ["--ro-bind", path, path]),
      "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--bind", "/tmp", "/tmp",
      "--dir", "/usr/local/bin", "--ro-bind", binary, "/usr/local/bin/rtk",
      "--ro-bind", root, root, "--bind", join(root, "tmp"), join(root, "tmp"),
      "--ro-bind", process.execPath, process.execPath, "--clearenv",
      "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", "/nonexistent",
      "--chdir", root, "--", process.execPath, ...process.argv.slice(1), "--native-rtk-view"],
    { env: {}, stdout: "inherit", stderr: "inherit" });
    process.exitCode = await child.exited;
  } finally { rmSync(fixture, { recursive: true, force: true }); }
  process.exit(process.exitCode ?? 1);
}
