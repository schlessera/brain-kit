"""Diagnostic-only immutable source and runner admission; no runtime setup here."""
import hashlib,json,os,pathlib,platform,re,subprocess,sys,time
BASE = "8cb45cc0bf8a74abbbf4d253ce70dea206d86307"
PARENT = "13af0e70d3209804604ab7f15d93befdef27dfc9"
MARKERS = {'.github/workflows/ci.yml': 'd87cebdc0f8d2594500091928c6f7db501dcab4fcc116750b48b9965cf8b9bb8', '.github/workflows/diag-3192.yml': '7297ffed0854f64c4b47a76a82a53d34a473c66ed01d57c0da6d9c1ced5e875a', 'scripts/native-proof/README.md': '279cd31d5d1d74dea505e1685ac10a34cd9c0378516fb6e56487e57bf364cbdb', 'scripts/native-proof/fixture.py': '48effd30f3383efa27f178a2e2e2c0603da83ffce2d09c1efcbfd7af761b3d2d', 'scripts/native-proof/held-loop-control.py': '1718b62e14f07ca5795eb2bb798202d10b3dc46c5158581f3d5ac0eb823c490f', 'scripts/native-proof/held-loop-runner.ts': '90de3ce72983ac47cd4be3fbe9bbbd88d694546b96c511be6d5c1e3e7e9096c9', 'scripts/native-proof/loop-evidence-control.py': 'cf3a646a04d3177b01cbd7c8c389dfb7273415a8a886f6bb9e13968c6e2ab489', 'scripts/native-proof/loop-evidence.py': 'e00f6fb3f35e717d2af2567b72b5d565c9566918750437fcaddffc9f76bc6416', 'scripts/native-proof/loop-trace.py': '4b2d6372917d7f9ffba33a6325df409a1f35a9c4190e2ae87a40bc6360617ab1', 'scripts/native-proof/verify-loop-diagnostic.py': 'e67adc1be3109c1327acb842911804b510547e19aa77833cf5fc957eb813d2ad', 'tests/identity-native-fixture.test.ts': '9a5b088e4e136ee02e987eb0b39db240253c560dd1e40efa9d60cb199b212fe8', 'tests/owned-loop-evidence.test.ts': 'b15f2ddabbb52d9b5c2d94bc21529cc32df79f5ce30d7d498a2e667a6aedd348'}
ALLOWED = set(MARKERS) | {".github/workflows/diag-3192.yml", "scripts/native-proof/admit-loop-diagnostic.py"}

def source_ok(head, parent, event_sha, changed, hashes, clean):
    return head == event_sha and parent == PARENT and clean and set(changed) == ALLOWED and all(hashes.get(path)==digest for path,digest in MARKERS.items())

def runner_ok(runner):
    return runner.get("osId")=="ubuntu" and runner.get("osVersion")=="24.04" and runner.get("arch")=="x86_64" and bool(re.fullmatch(r"7\.0\.\d+(?:-[0-9]+)?-azure",runner.get("kernel","")))

def loop_context(sysroot=pathlib.Path("/sys"), procroot=pathlib.Path("/proc")):
    result={"symbolCounts":{"lo_open":0,"lo_release":0},"countsComplete":False}
    try:
        with (sysroot/"module/loop/initstate").open() as stream: state=stream.read(65)
        result["moduleInitState"]=state.strip() if len(state)<=64 else {"unknown":"truncated"}
    except OSError as error: result["moduleInitState"]={"unknown":type(error).__name__,"errno":error.errno}
    try: (sysroot/"kernel/btf/loop").stat();result["moduleBTF"]=True
    except FileNotFoundError: result["moduleBTF"]=False
    except OSError as error: result["moduleBTF"]={"unknown":type(error).__name__,"errno":error.errno}
    deadline=time.monotonic()+1
    try:
        with (procroot/"kallsyms").open() as stream:
            for _ in range(500000):
                line=stream.readline(512)
                if not line: result["countsComplete"]=True;break
                fields=line.split()
                if len(fields)>=3 and fields[2] in result["symbolCounts"]: result["symbolCounts"][fields[2]]+=1
                if time.monotonic()>deadline: break
    except OSError as error: result["countsUnknown"]={"unknown":type(error).__name__,"errno":error.errno}
    return result  # Never export kallsyms lines, addresses, environments or process data.

def registration_ok(receipt):
    group=receipt.get("group","")
    for symbol in ("lo_open","lo_release"):
        row=receipt.get("availability",{}).get(symbol,{})
        writes=row.get("writes",[]); registration=row.get("registration") or {}
        if row.get("admitted") is not True or not writes: return False
        write=writes[0]; command=f"p:{group}/{symbol} {symbol} major=disk->major:u32 minor=disk->first_minor:u32 comm=$comm"
        if write.get("file")!="kprobe_events" or write.get("command")!=command or write.get("errno") is not None or write.get("writeBytes")!=len(command.encode())+1: return False
        if not all(key in write for key in ("before","after")): return False
        readback=registration.get("commandReadback") or "";format_text=registration.get("eventFormat") or ""
        if readback.split()[:1]!=[f"p:{group}/{symbol}"] or registration.get("formatValid") is not True: return False
        if not all(re.search(r"field:[^;\n]*\b"+name+r"(?:\[\d+\])?;",format_text) for name in ("major","minor","comm")): return False
    return bool(re.fullmatch(r"7\.0\.\d+(?:-[0-9]+)?-azure",receipt.get("kernel","")))

def registration_gate(path):
    path=pathlib.Path(path);result={"context":loop_context(),"status":"INCONCLUSIVE_BEFORE_PRODUCT"}
    try:
        receipt=json.loads(path.read_text());result["registrationPassed"]=registration_ok(receipt)
        if result["registrationPassed"]:result["status"]="REGISTRATION_WRITE_READBACK_FORMAT_PASSED_NOT_RUNTIME_ADMISSION"
    except Exception as error: result["unknown"]=type(error).__name__
    target=path.with_suffix(".registration.json");target.write_text(json.dumps(result,indent=2));target.chmod(0o644);print(json.dumps(result))
    if not result.get("registrationPassed"):raise SystemExit(1)

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

if __name__=="__main__":
    if len(sys.argv)==3 and sys.argv[1]=="--registration":registration_gate(sys.argv[2])
    else:main()
