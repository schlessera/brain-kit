"""Private #563 preparation/controller. Exactly three included-subscription turns."""
import argparse, base64, hashlib, json, os, pathlib, shutil, signal, subprocess, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
FORMS = ("flat", "shared", "shared-trimmed")
MODEL = "gpt-6.1-sol"
OWNED = ("scripts/measure-pi-schema.ts", "scripts/pi-schema-capture.ts", "scripts/pi-schema-measurement.ts", "scripts/pi-schema-offline-preload.ts", "scripts/pi-schema-preload.ts", "scripts/pi-schema-worker-preload.ts", "scripts/pi-schema-worker-receipts.ts", "scripts/pi-schema-replay.ts", "scripts/pi-schema-runner.py", "scripts/pi-schema-protocol.md", "tests/pi-schema-measurement.test.ts")
sha = lambda data: hashlib.sha256(data).hexdigest()
compact = lambda value: json.dumps(value, separators=(",", ":"), ensure_ascii=False)

def files_at(root):
    return {str(p.relative_to(root)): sha(p.read_bytes()) for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()}

def completed_flat_snapshot(flat, replay):
    names=("flat/result.json","flat/process-receipt.json","flat/receipts/physical-requests.json","flat/receipts/physical-1.sse","flat/receipts/physical-2.sse","flat/receipts/replay-events.jsonl","STOP.json","billing/state.json")
    hashes={name:sha((flat/name).read_bytes()) for name in names}
    value=json.loads((flat/"flat/result.json").read_text());record=value["record"];physical=json.loads((flat/"flat/receipts/physical-requests.json").read_text())
    if record.get("errors")!=[] or record.get("escapedBrain") is not False or value.get("provider")!="openai-codex" or value.get("model")!=MODEL or value.get("form")!="flat" or record.get("completed") is not True or record.get("showBlockCalls")!=[{"kind":"comparison","ok":True}] or record.get("result",{}).get("outcome")!="success" or record["result"].get("isError") is not False or len(physical)!=2:
        raise RuntimeError("Remaining-arm scope requires the preserved successful actual flat handler result.")
    if json.loads((flat/"flat/process-receipt.json").read_text()).get("exit")!=1 or physical[1].get("error")!="Invalid state: Controller is already closed" or physical[0].get("error") is not None or json.loads((flat/"billing/state.json").read_text()).get("stop") is not None:
        raise RuntimeError("Remaining-arm scope is limited to the exact historical postterminal observer-close stop.")
    if (flat/"flat/receipts/physical-1.sse").read_bytes()!=(replay/"flat/receipts/physical-1.error-body").read_bytes() or physical[0].get("provenance",{}).get("originalReceiptSha256")!=sha((replay/"flat/receipts/physical-requests.json").read_bytes()):
        raise RuntimeError("Historical original physical response must count exactly once.")
    original=json.loads((replay/"flat/receipts/physical-requests.json").read_text())[0]
    if physical[0].get("request")!=original.get("request") or physical[0].get("wireSha256")!=original.get("wireSha256"):raise RuntimeError("Recovered original request provenance mismatch.")
    known=lambda n:type(n) is int and 0<=n<=9007199254740991
    for index,item in enumerate(physical):
        events=[json.loads(line[6:]) for line in (flat/f"flat/receipts/physical-{index+1}.sse").read_text().splitlines() if line.startswith("data: ")]
        response=events[-1].get("response",{});usage=response.get("usage",{});cached=usage.get("input_tokens_details",{}).get("cached_tokens");reasoning=usage.get("output_tokens_details",{}).get("reasoning_tokens")
        auth=item.get("auth",{})
        if item.get("sequence")!=index+1 or item.get("form")!="flat" or item.get("route")!="native-codex-subscription" or auth.get("bearerMatchesNativeAccess") is not True or auth.get("accountHeaderMatchesNativeClaim") is not True or auth.get("originator")!="pi" or item.get("request",{}).get("model")!=MODEL:raise RuntimeError("Historical auth/model/physical identity mismatch.")
        if events[-1].get("type")!="response.completed" or response.get("status")!="completed" or response.get("model")!=MODEL or item.get("status")!=200 or item.get("requestedModel")!=MODEL or item.get("servedModel")!=MODEL or item.get("usage")!=usage or any(not known(usage.get(k)) for k in ("input_tokens","output_tokens","total_tokens")) or not known(cached) or not known(reasoning) or cached>usage["input_tokens"] or reasoning>usage["output_tokens"] or usage["total_tokens"]!=usage["input_tokens"]+usage["output_tokens"]:
            raise RuntimeError("Historical provider terminal/model/usage evidence mismatch.")
    first_response=[json.loads(line[6:]) for line in (flat/"flat/receipts/physical-1.sse").read_text().splitlines() if line.startswith("data: ")][-1]["response"]
    calls=[item for item in first_response["output"] if item.get("type")=="function_call"]
    if len(calls)!=1 or calls[0].get("name")!="show_block":raise RuntimeError("Historical original function call mismatch.")
    call=calls[0];request=physical[1]["request"];original_request=original["request"]
    if any(request.get(key)!=original_request.get(key) for key in set(request)|set(original_request) if key not in ("input","prompt_cache_key")):raise RuntimeError("Historical continuation semantic context mismatch.")
    inputs=request.get("input",[]);actual_call=next((item for item in inputs if item.get("type")=="function_call" and item.get("call_id")==call["call_id"]),None);actual_output=next((item for item in inputs if item.get("type")=="function_call_output" and item.get("call_id")==call["call_id"]),None)
    if actual_call is None or actual_call.get("name")!=call["name"] or actual_call.get("arguments")!=call["arguments"] or actual_output is None or json.loads(actual_output.get("output","null"))!=json.loads(call["arguments"]) or [item for item in inputs if item.get("role")=="user"]!=[item for item in original_request["input"] if item.get("role")=="user"]:raise RuntimeError("Historical continuation did not preserve the actual original call/handler/user context.")
    aggregate=record["result"]["usage"]
    if aggregate.get("inputTokens")!=sum(item["usage"]["input_tokens"] for item in physical) or aggregate.get("outputTokens")!=sum(item["usage"]["output_tokens"] for item in physical):raise RuntimeError("Historical physical usage must reconcile exactly once.")
    return {"originalExecutionDigest":"3d58bf7c3a491745da47f6a889f62c9cdad760137e261369cbad6a7a97324a9f","files":hashes,"physicalRequests":2,"actualLogicalFlatTurnCompleted":True,"actualParsedHandlerAccepted":True,"historicalStrictTransportGuardPassed":False,"historicalNaturalUpstreamEofKnown":False,"newFlatInferenceAllowed":False,"remainingForms":["shared","shared-trimmed"],"usageCountedOnce":True}

def current(bun, replay=None, completed_flat=None):
    tracked = subprocess.check_output(["rtk", "proxy", "git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    source = {name: sha((ROOT/name).read_bytes()) for name in sorted(set(tracked).union(OWNED)) if name and (ROOT/name).is_file() and not (ROOT/name).is_symlink()}
    corpus = files_at(ROOT/"packages/core/fixtures/corpus")
    old = json.loads((ROOT/"scripts/measurements/suggestions-2026-10-07/executed-manifest.json").read_text())
    if corpus != old["corpusFiles"] or sha(compact(corpus).encode()) != "d0f5d979e715e9c34cb4cdc25278c283e003bc0940040880d5a60eaa9b926bbd":
        raise RuntimeError("Reviewed corpus bytes drifted.")
    runtime = files_at(ROOT/"node_modules")
    links = {str(p.relative_to(ROOT)): str(p.readlink()) for p in sorted((ROOT/"node_modules").rglob("*")) if p.is_symlink()}
    version = subprocess.check_output([str(bun), "--version"], cwd=ROOT).decode().strip()
    if version != "1.4.2": raise RuntimeError("This protocol requires exact Bun1.4.2.")
    code='import {measurementSchema,PI_SCHEMA_PROMPT,PI_SCHEMA_ARMS} from "./scripts/pi-schema-measurement.ts"; import {toolInputJsonSchema,SHOW_BLOCK_DESCRIPTION} from "@schlessera/brain-ui-sdk/server"; console.log(JSON.stringify({prompt:PI_SCHEMA_PROMPT,description:SHOW_BLOCK_DESCRIPTION,options:PI_SCHEMA_ARMS,parameters:Object.fromEntries(["flat","shared","shared-trimmed"].map(form=>[form,toolInputJsonSchema(measurementSchema(form))]))}));'
    inputs=json.loads(subprocess.check_output([str(bun),"-e",code],cwd=ROOT))
    prefix=None
    if replay is not None:
        names=("flat/receipts/physical-requests.json","flat/receipts/physical-1.error-body","flat/process-receipt.json","STOP.json","billing/state.json")
        prefix={"originalFrozenDigest":"dafd4e9d143192eca12ea12c4ebb53ce66d89b3bf47704904d077179600b6818","files":{name:sha((replay/name).read_bytes()) for name in names},"originalPhysicalRequests":1,"remainingFlatPhysicalRequests":4,"sameServerSession":False,"unchangedRequestWire":False,"originalSuccessfulServerTurn":False}
        original=json.loads((replay/names[0]).read_text())
        if len(original)!=1 or original[0].get("form")!="flat" or original[0].get("sequence")!=1 or original[0].get("status")!=200 or json.loads((replay/"flat/process-receipt.json").read_text()).get("exit")!=1 or json.loads((replay/"STOP.json").read_text()).get("automaticRetry") is not False:
            raise RuntimeError("Replay source is not the preserved failed original single-request flat attempt.")
    return {"completedFlat":completed_flat_snapshot(completed_flat,replay) if completed_flat is not None else None,"replayPrefix":prefix,"issue":563,"model":MODEL,"provider":"openai-codex","forms":list(FORMS),"turnsPerForm":1,"physicalRequestsPerForm":5,"physicalRequestsTotal":15,"responseTimeoutSeconds":180,"processTimeoutSeconds":240,"inputs":inputs,"source":source,"runtime":runtime,"runtimeSymlinks":links,"corpus":corpus,"bunSha256":sha(bun.read_bytes()),"bunVersion":version,"promptReview":"scripts/measurements/suggestions-2026-10-07/review-receipt.json","corpusReview":"scripts/measurements/suggestions-2026-10-07/shared-corpus-review-receipt.json","billing":"included subscription only; no API fallback; missing invoice evidence unknown"}

def credentials():
    auth = json.loads((pathlib.Path.home()/".codex/auth.json").read_text())
    token = (auth.get("tokens") or {}).get("access_token")
    account = (auth.get("tokens") or {}).get("account_id")
    if auth.get("auth_mode") != "chatgpt" or auth.get("OPENAI_API_KEY") or not token or not account:
        raise RuntimeError("Required existing native ChatGPT login is absent or has an alternate billing key.")
    segment=token.split(".")[1]; payload=json.loads(base64.urlsafe_b64decode(segment+"="*(-len(segment)%4)))
    if not isinstance(payload.get("exp"),(int,float)) or payload["exp"]*1000 <= time.time()*1000+300000 or (payload.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id") != account:
        raise RuntimeError("Native login expiry/account claim mismatch; no refresh permitted.")
    return token, account

def wait_owned_process(command, env, stdout, stderr, timeout=240):
    timed_out=False;cleanup=[]
    process=subprocess.Popen(command, env=env, cwd=ROOT,stdout=stdout,stderr=stderr)
    try: status=process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out=True;process.terminate();cleanup.append("TERM owned bwrap process")
        try: status=process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill();cleanup.append("KILL owned bwrap process");status=process.wait(timeout=5)
    return {"exit":status,"exitSignal":signal.Signals(-status).name if status<0 else None,"timedOut":timed_out,"cleanup":cleanup,"bwrapExitObserved":process.returncode is not None,"childrenDrained":None}

def launch(out, form, bun, offline, mutation=None, expected_account=None, replay=None, completed_flat=None):
    run = out/form
    if run.exists(): raise RuntimeError("Existing arm directory forbids automatic mixed-run retry.")
    run.mkdir(mode=0o700)
    (out/"billing").mkdir(mode=0o700,exist_ok=True)
    billing=out/"billing/state.json"
    if completed_flat is not None and form=="shared":
        if billing.exists():raise RuntimeError("Remaining-arm billing snapshots must be imported once.")
        shutil.copyfile(completed_flat/"billing/state.json",billing);billing.chmod(0o600)
    if replay is not None and form=="flat":
        if billing.exists(): raise RuntimeError("Replay billing state must start from its preserved original snapshots once.")
        shutil.copyfile(replay/"billing/state.json",billing);billing.chmod(0o600)
    if billing.exists() and json.loads(billing.read_text()).get("stop"): raise RuntimeError("Known included-only stop forbids another arm.")
    shutil.copytree(ROOT/"packages/core/fixtures/corpus", run/"brain")
    if files_at(run/"brain")!=files_at(ROOT/"packages/core/fixtures/corpus"): raise RuntimeError("Fresh staged corpus copy differs from frozen source bytes.")
    for name in ("home","pi","receipts"): (run/name).mkdir(mode=0o700)
    env = {"PATH":"/runtime:/usr/bin:/bin","HOME":"/fixture-run/home","PI_CODING_AGENT_DIR":"/fixture-run/pi","BRAIN_MEASURE_PI_SCHEMA_FORM":form,"BRAIN_MEASURE_PI_RECEIPTS":"/fixture-run/receipts","BRAIN_MEASURE_PI_BILLING_STATE":"/billing/state.json","BRAIN_MEASURE_CODEX_MODEL":MODEL,"BRAIN_UI_MODEL_DISCOVERY":"0","BRAIN_UI_PRICING_DISCOVERY":"0"}
    if replay is not None and form=="flat":
        env.update({"BRAIN_MEASURE_PI_REPLAY_ROOT":"/replay-prefix","BRAIN_MEASURE_PI_REPLAY_RECEIPT_SHA":sha((replay/"flat/receipts/physical-requests.json").read_bytes()),"BRAIN_MEASURE_PI_REPLAY_RAW_SHA":sha((replay/"flat/receipts/physical-1.error-body").read_bytes())})
    if mutation: env["BRAIN_MEASURE_PI_OFFLINE_MUTATION"]=mutation
    if not offline:
        token,account=credentials()
        if expected_account is not None and account!=expected_account: raise RuntimeError("Native account scope changed; no new account is admitted.")
        env["BRAIN_MEASURE_CODEX_ACCESS_TOKEN"]=token; env["BRAIN_MEASURE_CODEX_ACCOUNT_ID"]=account
    command=["bwrap","--die-with-parent","--new-session","--unshare-user","--unshare-pid","--unshare-uts","--unshare-ipc"]
    if offline: command.append("--unshare-net")
    for system in ("/usr","/bin","/lib","/lib64","/etc/ssl","/etc/resolv.conf","/etc/hosts","/etc/nsswitch.conf"):
        if pathlib.Path(system).exists(): command.extend(["--ro-bind",system,system])
    if replay is not None and form=="flat":command.extend(["--ro-bind",str(replay),"/replay-prefix"])
    command.extend(["--proc","/proc","--dev","/dev","--tmpfs","/tmp","--ro-bind",str(ROOT),"/workspace","--ro-bind",str(bun.parent),"/runtime","--bind",str(run),"/fixture-run","--bind",str(out/"billing"),"/billing","--chdir","/fixture-run/brain","/runtime/bun"])
    if offline: command.extend(["--preload","/workspace/scripts/pi-schema-offline-preload.ts"])
    command.extend(["--preload","/workspace/scripts/pi-schema-preload.ts","/workspace/scripts/measure-pi-schema.ts","--brain","/fixture-run/brain","--out","/fixture-run/result.json"])
    started=time.monotonic()
    with (run/"stdout.log").open("wb") as stdout, (run/"stderr.log").open("wb") as stderr:
        process_receipt=wait_owned_process(command,env,stdout,stderr)
    receipt={**process_receipt,"form":form,"wallSeconds":time.monotonic()-started,"offline":offline,"networkNamespace":"isolated" if offline else "shared","pidContainment":"bwrap unshare-pid and die-with-parent","providerCalls":0 if offline else None,"actualAdditionalBilledUsd":None,"automaticRetry":False,"recoveredOriginalPhysicalRequests":1 if replay is not None and form=="flat" else 0}
    (run/"process-receipt.json").write_text(json.dumps(receipt,indent=2)+"\n")
    if receipt["timedOut"] or receipt["exit"] != 0: raise RuntimeError(f"Arm {form} failed; raw evidence preserved, no continuation or rerun.")
    if billing.exists() and json.loads(billing.read_text()).get("stop"): raise RuntimeError("Known included-only stop forbids further arms; evidence preserved.")
    value=json.loads((run/"result.json").read_text())
    count=len(value["physicalReceipts"])
    if count<1 or count>5: raise RuntimeError("Physical request count out of bounds.")
    return count

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--bun",type=pathlib.Path,required=True); parser.add_argument("--out",type=pathlib.Path,required=True)
    modes=parser.add_mutually_exclusive_group(required=True); modes.add_argument("--prepare",action="store_true"); modes.add_argument("--offline",action="store_true"); modes.add_argument("--live",action="store_true")
    parser.add_argument("--replay-prefix",type=pathlib.Path);parser.add_argument("--flat-completion-root",type=pathlib.Path)
    parser.add_argument("--freeze",type=pathlib.Path); parser.add_argument("--approval",type=pathlib.Path); parser.add_argument("--mutation",choices=("fixture-tools","tool-guard","replay-history"))
    args=parser.parse_args(); args.bun=args.bun.resolve(); args.out=args.out.resolve(); args.out.mkdir(parents=True,exist_ok=True,mode=0o700)
    if args.mutation and not args.offline: raise RuntimeError("Sentinel mutations are offline-only.")
    if args.replay_prefix: args.replay_prefix=args.replay_prefix.resolve()
    if args.flat_completion_root:args.flat_completion_root=args.flat_completion_root.resolve()
    if args.flat_completion_root and not args.replay_prefix:raise RuntimeError("Historical flat completion requires its exact original request prefix.")
    if args.live and (not args.replay_prefix or not args.flat_completion_root):raise RuntimeError("Current live scope requires exact successful historical flat evidence; only remaining shared arms may dispatch.")
    snapshot=current(args.bun,args.replay_prefix,args.flat_completion_root); digest=sha(compact(snapshot).encode())
    if args.prepare:
        target=args.out/"manifest.json"
        if target.exists(): raise RuntimeError("Refuse to overwrite a frozen source receipt.")
        target.write_text(json.dumps({"digest":digest,"manifest":snapshot},indent=2)+"\n"); print(json.dumps({"digest":digest,"path":str(target)})); return
    if args.live:
        if not args.freeze or not args.approval: raise RuntimeError("Exact frozen source and independently reviewed approval required before live dispatch.")
        frozen=json.loads(args.freeze.read_text()); approval=json.loads(args.approval.read_text())
        if frozen.get("digest")!=digest or frozen.get("manifest")!=snapshot or approval.get("approved") is not True or approval.get("frozenDigest")!=digest or approval.get("method")!="remaining-shared-after-observer-stop": raise RuntimeError("Source freeze or independent approval mismatch.")
        _,expected_account=credentials() # read-only; no login, refresh, files copied or identity output
    if args.live and (args.out/"STOP.json").exists(): raise RuntimeError("Prior stopped invocation requires a fresh explicit scope; never resume automatically.")
    total=2 if args.flat_completion_root is not None else 0
    try:
        for form in (FORMS[1:] if args.flat_completion_root is not None else FORMS):
            if args.live and current(args.bun,args.replay_prefix,args.flat_completion_root)!=snapshot: raise RuntimeError("Frozen source/runtime/corpus drift before invocation.")
            total+=launch(args.out,form,args.bun,args.offline,args.mutation,expected_account if args.live else None,args.replay_prefix,args.flat_completion_root)
            if total>15: raise RuntimeError("Aggregate physical request ceiling exceeded.")
            print(json.dumps({"form":form,"complete":True,"physicalRequestsTotal":total,"offline":args.offline}),flush=True)
    except Exception as error:
        (args.out/"STOP.json").write_text(json.dumps({"reason":str(error),"complete":False,"automaticRetry":False,"knownCompletedPhysicalRequests":total,"actualAdditionalBilledUsd":None},indent=2)+"\n")
        raise

if __name__=="__main__": main()
