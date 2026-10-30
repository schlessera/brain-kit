"""Optional owned-loop tracing; kernel-resolved BTF, no guessed offsets.
See docs.kernel.org/trace/kprobetrace.html and the existing dead-root trace.
"""
import json, os, pathlib, re, sys, tempfile, time, uuid

TRACE = pathlib.Path("/sys/kernel/tracing")
STATE = pathlib.Path("/run/brain-kit-owned-loop-trace.json")
SYMBOLS = ("lo_open", "lo_release")
FILTER = "major == 7 && minor == 1790"
LIMIT = 4 * 1024 * 1024

def write(path, value):
    try:
        with path.open("a" if path.name == "kprobe_events" else "w") as stream: stream.write(value + "\n")
    except OSError as error:
        error.tracePhase = path.name
        raise

def save(path, value):
    # Replace rather than truncate a runner-owned file (protected_regular in /tmp).
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = pathlib.Path(stream.name)
        try:
            json.dump(value, stream)
            if path != STATE and os.environ.get("SUDO_UID", "").isdecimal(): os.fchown(stream.fileno(), int(os.environ["SUDO_UID"]), -1)
        except BaseException:
            temporary.unlink(); raise
    try: temporary.replace(path)
    finally: temporary.unlink(missing_ok=True)

def available(symbol):
    deadline = time.monotonic() + 1
    with (TRACE / "available_filter_functions").open() as stream:
        for _ in range(65536):
            line = stream.readline(512)
            if not line: return False
            if line.split()[:1] == [symbol]: return True
            if time.monotonic() >= deadline: return "unknown: scan time limit"
    return "unknown: scan count limit"

def failure(error, phase, group, symbol=""):
    # Retain only own probe context, bounded in bytes/lines; never reset error_log.
    text, log_unknown = "", None
    try:
        with (TRACE / "error_log").open() as stream: text = stream.read(16384)
        lines = text.splitlines()[-24:]
        selected = {j for i, line in enumerate(lines) if (group and group in line) or (symbol and symbol in line) for j in (max(0, i-1), i)}
        tail = [re.sub(r"/\S+", "<redacted>", lines[i])[:256] for i in sorted(selected)][-8:]
    except OSError as diagnostic: tail, log_unknown = [], type(diagnostic).__name__
    return dict(failure=type(error).__name__, errno=getattr(error, "errno", None), phase=phase,
                classification="syntax-or-implementation" if tail else "unknown", errorLog=tail, errorLogTruncated=len(text) == 16384, errorLogUnknown=log_unknown)

def start(output):
    output.parent.mkdir(parents=True, exist_ok=True)
    state = dict(group="brainloop_" + uuid.uuid4().hex[:12], output=str(output), events=[])
    receipt = dict(kernel=os.uname().release, monoNs=time.monotonic_ns(), clock="mono", device="7:1790", group=state["group"], availability={})
    # Exclusive reservation: losing invocations cannot unregister or unlink state.
    with STATE.open("x") as stream: json.dump(state, stream)
    STATE.chmod(0o600)
    save(output, receipt)
    instance = TRACE / "instances" / state["group"]
    instance.mkdir(); state["instanceCreated"] = True; save(STATE, state)
    write(instance / "tracing_on", "0")
    write(instance / "trace_clock", "mono")
    write(instance / "buffer_size_kb", "64")
    for symbol in SYMBOLS:
        phase = "symbol-admission"
        try:
            found = available(symbol)
            if found is not True:
                receipt["availability"][symbol] = dict(classification="not-traceable" if found is False else "unknown", available=found)
                continue
            phase = "registration"
            write(TRACE / "kprobe_events", f"p:{state['group']}/{symbol} {symbol} major=disk->major:u32 minor=disk->first_minor:u32 comm=$comm")
            state["events"].append(symbol); save(STATE, state)
            base = instance / "events" / state["group"] / symbol
            for phase, file, value in (("filter", "filter", FILTER), ("stack-trigger", "trigger", "stacktrace if " + FILTER), ("enable", "enable", "1")):
                write(base / file, value)
            receipt["availability"][symbol] = dict(admitted=True, filter=FILTER, stack=True)
        except Exception as error: receipt["availability"][symbol] = failure(error, phase, state["group"], symbol)
    save(output, receipt)
    write(instance / "tracing_on", "1")

def stop():
    if not STATE.exists(): return
    state = json.loads(STATE.read_text()); output = pathlib.Path(state["output"])
    receipt = json.loads(output.read_text()); instance = TRACE / "instances" / state["group"]
    if not state.get("instanceCreated"): STATE.unlink(); return
    write(instance / "tracing_on", "0")
    for symbol in state["events"]:
        base = instance / "events" / state["group"] / symbol
        write(base / "enable", "0")
        write(base / "trigger", "!stacktrace")
    with (instance / "trace").open("rb") as stream: raw = stream.read(LIMIT + 1)
    save(output.with_suffix(".trace.json"), dict(trace=raw[:LIMIT].decode(errors="backslashreplace"), truncated=len(raw) > LIMIT))
    instance.rmdir()
    for symbol in state["events"]: write(TRACE / "kprobe_events", f"-:{state['group']}/{symbol}")
    receipt["stoppedMonoNs"] = time.monotonic_ns()
    save(output, receipt)
    STATE.unlink()

def main(args):
    try:
        if args == ["stop"]: stop()
        elif len(args) == 2 and args[0] == "start": start(pathlib.Path(args[1]).resolve())
        else: raise ValueError("usage")
    except Exception as error:
        # CI also uses continue-on-error: even an output/cleanup error cannot gate proof.
        try: group = json.loads(STATE.read_text())["group"]
        except Exception: group = ""
        print(json.dumps(dict(kind="owned-loop-availability-failure", action=args[:1],
                              **failure(error, getattr(error, "tracePhase", "lifecycle"), group))), flush=True)
        return 1
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
