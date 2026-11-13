/**
 * A one-day fixture CA and one certificate it signs for fictional host names,
 * made with the system openssl in a caller-owned directory. Offline; nothing
 * is installed or trusted outside the process told about the CA file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function run(argv: string[], cwd: string): void {
  const child = Bun.spawnSync(argv, { cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd }, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${child.stderr.toString()}`);
}

export function fixtureTls(dir: string, names: readonly string[]): { ca: string; cert: string; key: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ca = join(dir, "ca.pem"), caKey = join(dir, "ca-key.pem"), cert = join(dir, "cert.pem"), key = join(dir, "key.pem"), csr = join(dir, "cert.csr");
  run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Odysseus fixture CA", "-keyout", caKey, "-out", ca], dir);
  run(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${names[0]}`, "-keyout", key, "-out", csr], dir);
  writeFileSync(join(dir, "san.ext"), `subjectAltName=${names.map(name => `DNS:${name}`).join(",")}\n`);
  run(["openssl", "x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-extfile", join(dir, "san.ext"), "-out", cert], dir);
  return { ca, cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}
