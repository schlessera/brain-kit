"""Optional owned-loop tracing; kernel-resolved BTF, no guessed offsets.
See docs.kernel.org/trace/kprobetrace.html and the existing dead-root trace.
"""
import hashlib, json, os, pathlib, re, sys, tempfile, time, uuid

TRACE = pathlib.Path("/sys/kernel/tracing")
STATE = pathlib.Path("/run/brain-kit-owned-loop-trace.json")
SYMBOLS = ("lo_open", "lo_release")
FILTER = "major == 7 && minor == 1790"
LIMIT = 4 * 1024 * 1024

def snapshot(text, command):
    if text is None: return dict(unknown="error_log unreadable")
    lines = text.splitlines(); own = []
    for i, line in enumerate(lines):
        if command.startswith(("p:brainloop_", "-:brainloop_")) and line.strip() == "Command: " + command:
            own.extend(lines[max(0, i-1):i+2])
    raw = "\n".join(own)
    safe = re.sub(r"0x[0-9a-fA-F]{8,}|(?<![\w/])/\S+|\b[0-9a-fA-F]{16}\b", "<redacted>", raw)
    return dict(capturedBytes=len(text.encode()), sha256=hashlib.sha256(text.encode()).hexdigest(),
                scopedRaw=safe[:4096], unrelatedRedacted=bool(text and raw.strip() != text.strip()), globalRawRetained=False,
                emptyObserved=text == "", scopeRedacted=safe != raw, scopeUnknown=bool(text) and not command.startswith(("p:brainloop_", "-:brainloop_")), captureLimitChars=8192, truncationUnknown=len(text)==8192)

def write(path, value):
    before = error_tail(); payload = (value + "\n").encode()
    evidence = dict(file=path.name, command=value, errno=None, writeBytes=0)
    try:
        if path.name == "kprobe_events":
            # CPython append-mode FileIO seeks SEEK_END; seq_lseek rejects it.
            # No O_CREAT, O_TRUNC, text buffering or seek: parse exactly ONE write.
            fd = os.open(path, os.O_WRONLY | os.O_APPEND)
            try:
                count = os.write(fd, payload)
                if count != len(payload): raise OSError(5, "short trace command write")
                evidence["writeBytes"] = count
            finally: os.close(fd)
        else:
            with path.open("w") as stream: stream.write(value + "\n")
            evidence["writeBytes"] = len(payload)
    except OSError as error:
        evidence.update(errno=error.errno, before=snapshot(before, value), after=snapshot(error_tail(), value))
        error.tracePhase, error.writeEvidence = path.name, evidence
        raise
    evidence.update(before=snapshot(before, value), after=snapshot(error_tail(), value))
    return evidence

def registration_readback(instance, group, symbol):
    line = None; deadline = time.monotonic() + 1
    with (TRACE / "kprobe_events").open() as stream:
        for _ in range(65536):
            candidate = stream.readline(4096)
            if not candidate or time.monotonic() > deadline: break
            if candidate.split()[:1] == [f"p:{group}/{symbol}"]: line = candidate.strip(); break
    with (instance / "events" / group / symbol / "format").open() as stream: format_text = stream.read(16385)
    valid = len(format_text) <= 16384 and all(re.search(r"field:(?:u32|unsigned int) " + field + r";[^\n]*size:4;", format_text) for field in ("major", "minor")) and bool(re.search(r"field:[^;\n]*\bcomm(?:\[\d+\])?;", format_text))
    proof = dict(commandReadback=line, eventFormat=format_text[:16384], formatValid=bool(valid))
    return proof

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

def error_tail():
    try:
        with (TRACE / "error_log").open() as stream: return stream.read(16384)[-8192:]
    except OSError: return None

def failure(error, phase, group, symbol="", command=None, before=None):
    # Exact NEW command context only. This is a hint, not syntax/platform attribution.
    after = error_tail(); context = []
    if before is not None and after is not None and command is not None:
        lines = after.splitlines()
        for i, line in enumerate(lines):
            if line.strip() == "Command: " + command:
                block = "\n".join(lines[max(0, i-1):i+2])
                if block not in before:
                    scoped = snapshot(block, command)["scopedRaw"][:1024]
                    if scoped: context.append(scoped)
    return dict(failure=type(error).__name__, errno=getattr(error, "errno", None), phase=phase,
                symbol=symbol, classification="hint-only: rejected command" if context else "unknown",
                errorLog=context[-2:], errorLogUnknown=after is None, errorLogBefore=snapshot(before, command or ""),
                errorLogAfter=snapshot(after, command or ""), writeEvidence=getattr(error, "writeEvidence", None))

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
        phase = "registration"
        command = f"p:{state['group']}/{symbol} {symbol} major=disk->major:u32 minor=disk->first_minor:u32 comm=$comm"
        before = error_tail(); writes = []; registration = None
        try:
            writes.append(write(TRACE / "kprobe_events", command))
            state["events"].append(symbol); save(STATE, state)
            phase = "registration-readback"
            registration = registration_readback(instance, state["group"], symbol)
            if not registration["commandReadback"] or not registration["formatValid"]: raise ValueError("own command readback or event format unavailable")
            base = instance / "events" / state["group"] / symbol
            for phase, file, value in (("filter", "filter", FILTER), ("stack-trigger", "trigger", "stacktrace if " + FILTER), ("enable", "enable", "1")):
                command, before = value, error_tail()
                writes.append(write(base / file, value))
            receipt["availability"][symbol] = dict(admitted=True, filter=FILTER, stack=True, registration=registration, writes=writes)
        except Exception as error:
            detail = failure(error, phase, state["group"], symbol, command, before)
            if phase == "registration":
                try: detail["ftraceListingHint"] = available(symbol)
                except OSError: detail["ftraceListingHint"] = "unknown"
            detail["writes"] = writes
            detail["registration"] = registration
            receipt["availability"][symbol] = detail
    save(output, receipt)
    write(instance / "tracing_on", "1")

def stop():
    if not STATE.exists(): return
    state = json.loads(STATE.read_text()); output = pathlib.Path(state["output"])
    instance = TRACE / "instances" / state["group"]; errors = []; writes = []
    def attempt(action):
        try: return action()
        except Exception as error: errors.append(error)
    def emit(path, value):
        try: writes.append(write(path, value))
        except OSError as error:
            writes.append(getattr(error, "writeEvidence", None)); raise
    if state.get("instanceCreated"):
        attempt(lambda: emit(instance / "tracing_on", "0"))
        def salvage():
            with (instance / "trace").open("rb") as stream: raw = stream.read(LIMIT + 1)
            save(output.with_suffix(".trace.json"), dict(trace=raw[:LIMIT].decode(errors="backslashreplace"), truncated=len(raw) > LIMIT))
        attempt(salvage)  # Freeze and salvage BEFORE disable, unregister or receipt reads.
        for symbol in state["events"]:
            base = instance / "events" / state["group"] / symbol
            attempt(lambda: emit(base / "enable", "0"))
            attempt(lambda: emit(base / "trigger", "!stacktrace"))
        attempt(instance.rmdir)
        for symbol in state["events"]:
            attempt(lambda: emit(TRACE / "kprobe_events", f"-:{state['group']}/{symbol}"))
    receipt = attempt(lambda: json.loads(output.read_text()))
    if receipt is not None and not errors:
        receipt["stoppedMonoNs"] = time.monotonic_ns()
        receipt["stopWrites"] = writes
        attempt(lambda: save(output, receipt))
    if errors:
        attempt(lambda: save(output.with_suffix(".stop.json"), dict(cleanupFailures=[type(e).__name__ for e in errors], originalFailure=type(errors[0]).__name__, writes=writes)))
        raise errors[0]
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
