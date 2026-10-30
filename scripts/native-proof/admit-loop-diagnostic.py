"""Diagnostic-only immutable source and runner admission; no runtime setup here."""
import hashlib,json,os,pathlib,platform,re,subprocess,sys
BASE = "8cb45cc0bf8a74abbbf4d253ce70dea206d86307"
PARENT = "a35a71472ca238e821da69fec22464f193915386"
MARKERS = {'.github/workflows/ci.yml': 'd87cebdc0f8d2594500091928c6f7db501dcab4fcc116750b48b9965cf8b9bb8', 'scripts/native-proof/README.md': 'b780692630a08034f2d0287d1ebf72b03862e93b20dc5f5056cbbf0b49a07131', 'scripts/native-proof/fixture.py': '48effd30f3383efa27f178a2e2e2c0603da83ffce2d09c1efcbfd7af761b3d2d', 'scripts/native-proof/loop-evidence-control.py': '28bc4a421b16422adc6c8bb216e72ce4beec5a4f0e206661ca4fa083ce3bbc51', 'scripts/native-proof/loop-evidence.py': 'e00f6fb3f35e717d2af2567b72b5d565c9566918750437fcaddffc9f76bc6416', 'scripts/native-proof/loop-trace.py': 'ccaf30e4cbf720d67948eaa0f4065ff08816c438aa52f12b9550dacd859dc84c', 'tests/identity-native-fixture.test.ts': '9a5b088e4e136ee02e987eb0b39db240253c560dd1e40efa9d60cb199b212fe8', 'tests/owned-loop-evidence.test.ts': '1077d953ddf0fb42401b9806aefe41b139100e445e9b5a71b1650acbae57b64b', 'scripts/native-proof/held-loop-runner.ts': '90de3ce72983ac47cd4be3fbe9bbbd88d694546b96c511be6d5c1e3e7e9096c9', 'scripts/native-proof/held-loop-control.py': '1718b62e14f07ca5795eb2bb798202d10b3dc46c5158581f3d5ac0eb823c490f', 'scripts/native-proof/verify-loop-diagnostic.py': 'e67adc1be3109c1327acb842911804b510547e19aa77833cf5fc957eb813d2ad', '.github/workflows/diag-3192.yml': '09382069799a87b4bb0e2630104694fbb84c2741feb3190742e62d74928e44b4'}
ALLOWED = set(MARKERS) | {".github/workflows/diag-3192.yml", "scripts/native-proof/admit-loop-diagnostic.py"}

def source_ok(head, parent, event_sha, changed, hashes, clean):
    return head == event_sha and parent == PARENT and clean and set(changed) == ALLOWED and all(hashes.get(path)==digest for path,digest in MARKERS.items())

def runner_ok(runner):
    return runner.get("osId")=="ubuntu" and runner.get("osVersion")=="24.04" and runner.get("arch")=="x86_64" and bool(re.fullmatch(r"7\.0\.\d+(?:-[0-9]+)?-azure",runner.get("kernel","")))

def main():
    def git(*args): return subprocess.check_output(["git",*args],text=True).strip()
    output=pathlib.Path("tmp/native-host-proof");output.mkdir(parents=True,exist_ok=True)
    observed=dict(kernel=platform.release(),arch=platform.machine(),cpus=os.cpu_count(),osId=platform.freedesktop_os_release().get("ID"),osVersion=platform.freedesktop_os_release().get("VERSION_ID"))
    head=git("rev-parse","HEAD");parent=git("show","-s","--format=%P","HEAD")
    hashes={path:hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() for path in MARKERS}
    valid=source_ok(head,parent,os.environ["GITHUB_SHA"],git("diff","--name-only",BASE,"HEAD").splitlines(),hashes,not git("status","--porcelain"))
    receipt=dict(sourceValid=valid,runnerClassAdmitted=runner_ok(observed),checkout=dict(sha=head,tree=git("rev-parse","HEAD^{tree}"),parent=parent),observed=observed,hashes=hashes,limits=["Runner class only, not historical image equality","Live BTF and actual events still unproved"])
    (output/"diagnostic-source-admission.json").write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
    if not valid or not runner_ok(observed): raise SystemExit(1)

if __name__=="__main__":main()
