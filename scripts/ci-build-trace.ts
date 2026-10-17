/** Diagnostic observer for this build only; it grants no reuse authority. */
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { buildRead } from "./ci-build-files";
import { digest, identity } from "./ci-build-boundary";
const libraries = ["/lib/x86_64-linux-gnu/libunwind-ptrace.so.0", "/lib/x86_64-linux-gnu/libunwind-x86_64.so.8", "/lib/x86_64-linux-gnu/libc.so.6", "/lib/x86_64-linux-gnu/liblzma.so.5", "/lib/x86_64-linux-gnu/libunwind.so.8"];
export function prepareBuildTrace(directory: string) {
  const source = join(directory, "trace-tool"); mkdirSync(source, { mode: 0o700 }); mkdirSync(join(source, "lib"), { mode: 0o700 });
  const records: {path: string; sha256: string; mode: number}[] = [];
  for (const [from, path] of [["/usr/bin/strace", "strace"], ["/lib64/ld-linux-x86-64.so.2", "loader"], ...libraries.map(path => [path, `lib/${basename(path)}`])]) {
    const captured = buildRead(realpathSync(from!)); const mode = Number(captured.stat.mode & 0o7777n);
    writeFileSync(join(source, path!), captured.bytes, { flag: "wx", mode }); chmodSync(join(source, path!), mode);
    records.push({ path: path!, sha256: digest(captured.bytes), mode });
  }
  // The observer's loader applies its own library path only to strace. It is
  // not LD_LIBRARY_PATH inherited by Bun, Node or the actual compiler children.
  const command = ["/trace/loader", "--library-path", "/trace/lib", "/trace/strace", "--kill-on-exit", "-f", "-q", "--syscall-limit=1000000", "-yy", "-ttt", "-s", "256", "-o", "/repo/tmp/qualification-syscalls.log", "-e", "trace=%file,%process,%net,%clock,getrandom,uname,sysinfo,sched_getaffinity", "/bin/sh", "/tool/entry.sh"];
  const script = "#!/bin/sh\nset -eu\nulimit -f 524288\nexec " + command.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ") + "\n";
  writeFileSync(join(source, "observe.sh"), script, { flag: "wx", mode: 0o700 }); chmodSync(join(source, "observe.sh"), 0o700);
  records.push({ path: "observe.sh", sha256: digest(script), mode: 0o700 });
  return { source, identity: identity(records), records, command: ["/bin/sh", "/trace/observe.sh"] };
}
const pathCalls = new Set(["open", "openat", "openat2", "stat", "lstat", "newfstatat", "statx", "access", "faccessat", "faccessat2", "readlink", "readlinkat", "execve", "execveat", "chdir", "mkdir", "mkdirat", "unlink", "unlinkat", "rename", "renameat", "renameat2", "chmod", "fchmodat", "chown", "lchown", "utimensat"]);
const ambientCalls = new Set(["clock_gettime", "clock_gettime64", "gettimeofday", "time", "getrandom", "uname", "sysinfo", "sched_getaffinity"]);
export function classifyBuildTrace(text: string) {
  if (Buffer.byteLength(text) > 256 * 1024 * 1024) throw new Error("Build trace exceeds bounded observation");
  const paths = new Map<string, {path: string; domain: string}>(), unknowns = new Set<string>(), syscalls: Record<string, number> = {}, cwd = new Map<string, string>(), pending = new Map<string, string>();
  const seen = new Set<string>(), exited = new Set<string>();
  let calls = 0;
  for (let line of text.split("\n")) {
    if (!line.trim()) continue;
    const prefix = /^(\d+)\s+(?:\d+\.\d+\s+)?(.*)$/.exec(line);
    if (!prefix) { unknowns.add("trace-format-or-observer-message"); continue; }
    const pid = prefix[1]!; seen.add(pid); line = prefix[2]!;
    if (line.includes("<unfinished ...>")) { pending.set(pid, line.replace("<unfinished ...>", "")); continue; }
    if (line.startsWith("<... ")) {
      const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(line), start = pending.get(pid);
      if (!resumed || !start) { unknowns.add("unpaired-resumed-syscall"); continue; }
      line = start + resumed[2]; pending.delete(pid);
    }
    if (line.startsWith("+++ exited with ") || line.startsWith("+++ killed by ")) { exited.add(pid); continue; }
    if (line.startsWith("--- ")) continue;
    const call = /^(\w+)\(/.exec(line)?.[1];
    if (!call) { unknowns.add("incomplete-or-unrecognized-syscall"); continue; }
    calls++;
    syscalls[call] = (syscalls[call] ?? 0) + 1;
    if (ambientCalls.has(call)) unknowns.add(`ambient:${call}:source-audit-required`);
    if (["socket", "connect", "sendto", "sendmsg"].includes(call)) unknowns.add(`network-or-interface:${call}`);
    if (["clone", "clone3", "fork", "vfork"].includes(call)) {
      const child = /= (\d+)(?:\s|$)/.exec(line)?.[1]; if (child) cwd.set(child, cwd.get(pid) ?? "/repo");
    }
    if (!pathCalls.has(call)) continue;
    if (["rename", "renameat", "renameat2"].includes(call)) unknowns.add(`additional-path-operands:${call}:review-required`);
    const quoted = /"(?:\\.|[^"\\])*"/.exec(line)?.[0];
    if (!quoted || /"\.\.\./.test(line)) { unknowns.add(`unresolved-path:${call}`); continue; }
    let path: string;
    try { path = JSON.parse(quoted); } catch { unknowns.add(`non-json-path-escape:${call}`); continue; }
    const resolved = /= \d+<([^>]+)>/.exec(line)?.[1];
    if (resolved?.startsWith("/")) path = resolved;
    else if (!path.startsWith("/")) {
      const descriptor = /^[^(]+\((\d+)<([^>]+)>/.exec(line)?.[2];
      if (/^[^(]+\(\d+[,)]/.test(line) && !descriptor) { unknowns.add(`unresolved-dirfd:${call}`); continue; }
      path = posix.resolve(descriptor ?? cwd.get(pid) ?? "/repo", path);
    }
    if (call === "chdir" && line.endsWith("= 0")) cwd.set(pid, path);
    let domain: string;
    if (path === "/repo/tmp" || path.startsWith("/repo/tmp/") || path === "/tmp" || path.startsWith("/tmp/")) domain = "fresh-private-review-required";
    else if (/^\/repo\/packages\/[^/]+\/dist(?:\/|$)/.test(path)) domain = "checked-derived-or-current-output";
    else if (path === "/repo" || path.startsWith("/repo/")) domain = "captured-input";
    else if (path === "/tool" || path.startsWith("/tool/") || path.startsWith("/operation/")) domain = "captured-tool-and-entry";
    else if (path === "/trace" || path.startsWith("/trace/")) domain = "diagnostic-only";
    else if (/^\/(proc|sys|dev)(?:\/|$)/.test(path)) { domain = "kernel-or-device-unqualified"; unknowns.add(`ambient-path:${digest(path)}`); }
    else domain = "immutable-image-or-absence-review-required";
    // Raw host-like paths from original-checkout canaries are not public data.
    const label = path.startsWith("/repo/") ? path.slice(6) : /^(\/usr\/|\/lib|\/etc\/|\/bin\/)/.test(path) ? `image:${path}` : `path-sha256:${digest(path)}`;
    paths.set(`${domain}:${label}`, { path: label, domain });
  }
  const terminated = seen.size > 0 && [...seen].every(pid => exited.has(pid));
  if (pending.size || !terminated || calls >= 1_000_000) unknowns.add("trace-not-complete");
  // vDSO/hardware inputs can bypass syscalls; observation alone cannot close them.
  unknowns.add("runtime-vdso-hardware-and-ambient-source-audit-required");
  return { version: 1, purpose: "qualification-trace", authority: "none", completeObservation: !unknowns.has("trace-not-complete") && !unknowns.has("trace-format-or-observer-message") && !unknowns.has("unpaired-resumed-syscall") && !unknowns.has("incomplete-or-unrecognized-syscall"), paths: [...paths.values()].sort((a,b)=>a.path.localeCompare(b.path)), syscalls, unknowns: [...unknowns].sort(), ambientQualified: false };
}
