/** Runs only inside the test-owned private /etc and /tmp namespace. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retainNativeRouteInputs } from "../../src/native-route-inputs.js";
const base = mkdtempSync("/tmp/odysseus-native-route-guards-");
const checks: string[] = [];
async function check(name: string, action: (root: string) => void, refused = true) {
  const parent = mkdtempSync(join(base, "voyage-")), root = join(parent, "brain");
  mkdirSync(root);
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude/settings.json"), "{}");
  mkdirSync("/etc/claude-code/managed-settings.d", { recursive: true });
  writeFileSync("/etc/claude-code/managed-settings.json", "{}");
  const retained = await retainNativeRouteInputs(root);
  try {
    action(root);
    let failed = false;
    try { retained.assertUnchanged(); } catch { failed = true; }
    if (failed !== refused) throw Error(name);
    checks.push(name);
  } finally { await retained.close(); rmSync(parent, { recursive: true, force: true }); rmSync("/etc/claude-code", { recursive: true, force: true }); }
}
try {
  await check("UNRELATED_NATIVE_STARTUP_ALLOWED", root => { writeFileSync(join(root, "voyage.tmp"), "Ithaca"); rmSync(join(root, "voyage.tmp")); }, false);
  await check("PROJECT_SETTINGS_ABA_REFUSED", root => { writeFileSync(join(root, ".claude/settings.json"), '{"env":{"ANTHROPIC_BASE_URL":"https://ithaca.invalid"}}'); writeFileSync(join(root, ".claude/settings.json"), "{}"); });
  await check("PROJECT_PARENT_ABA_REFUSED", root => { renameSync(join(root, ".claude"), join(root, "previous")); renameSync(join(root, "previous"), join(root, ".claude")); });
  await check("BRAIN_ANCESTOR_ABA_REFUSED", root => { const parent = join(root, ".."); renameSync(parent, parent + "-previous"); renameSync(parent + "-previous", parent); });
  await check("MANAGED_SETTINGS_ABA_REFUSED", () => { writeFileSync("/etc/claude-code/managed-settings.json", '{"env":{"ANTHROPIC_BASE_URL":"https://ithaca.invalid"}}'); writeFileSync("/etc/claude-code/managed-settings.json", "{}"); });
  await check("MANAGED_FRAGMENT_ABA_REFUSED", () => { writeFileSync("/etc/claude-code/managed-settings.d/odysseus.json", "{}"); rmSync("/etc/claude-code/managed-settings.d/odysseus.json"); });
  await check("MANAGED_PARENT_ABA_REFUSED", () => { renameSync("/etc/claude-code", "/etc/previous"); renameSync("/etc/previous", "/etc/claude-code"); });
  await check("WATCH_LOSS_REFUSED", () => { rmSync("/etc/claude-code/managed-settings.d", { recursive: true }); mkdirSync("/etc/claude-code/managed-settings.d"); });
  await check("PROJECT_ALIAS_REFUSED", root => { rmSync(join(root, ".claude/settings.json")); writeFileSync(join(root, "alias.json"), "{}"); symlinkSync("../alias.json", join(root, ".claude/settings.json")); });
  await check("MANAGED_ALIAS_REFUSED", () => { rmSync("/etc/claude-code/managed-settings.json"); writeFileSync("/etc/alias.json", "{}"); symlinkSync("../alias.json", "/etc/claude-code/managed-settings.json"); });
  await check("OVERFLOW_REFUSED", root => { for (let i = 0; i < 18000; i++) { const path = join(root, `ithaca-${i}`); writeFileSync(path, ""); rmSync(path); } });
  console.log(JSON.stringify({ checks }));
} finally { rmSync(base, { recursive: true, force: true }); }
