"""Independent, optional owned-loop trace. Admit offsets from live BTF only.

No fallback offsets, unfiltered enabled events, host census or global reset.
Run as root under the existing CI trace authority. Missing support is evidence.
"""
import json, os, pathlib, signal, subprocess, sys, time, uuid

TRACE = pathlib.Path("/sys/kernel/tracing")
STATE = pathlib.Path("/run/brain-kit-owned-loop-trace.json")
LIMIT = 4 * 1024 * 1024

def layout(types, symbol):
    by_id = {item["id"]: item for item in types}
    def resolve(ident):
        item = by_id[ident]
        for _ in range(16):
            if item["kind"] not in ("TYPEDEF", "CONST", "VOLATILE", "RESTRICT"): return item
            item = by_id[item["type_id"]]
        raise ValueError("type-cycle")
    def field(structure, name):
        matches = [m for m in structure["members"] if m["name"] == name]
        if len(matches) != 1: raise ValueError("field-unavailable")
        member = matches[0]
        kind = resolve(member["type_id"])
        if member["bits_offset"] % 8 or member.get("bitfield_size", 0) or kind["kind"] != "INT" or kind["size"] != 4:
            raise ValueError("unsupported-field-layout")
        return member["bits_offset"] // 8
    functions = [t for t in types if t["kind"] == "FUNC" and t["name"] == symbol]
    if len(functions) != 1: raise ValueError("function-unavailable")
    proto = resolve(functions[0]["type_id"])
    first = resolve(proto["params"][0]["type_id"])
    if first["kind"] != "PTR": raise ValueError("argument-not-pointer")
    disk = resolve(first["type_id"])
    if disk["kind"] != "STRUCT" or disk["name"] != "gendisk": raise ValueError("argument-not-gendisk")
    return field(disk, "major"), field(disk, "first_minor")

def definitions(types, symbol, group):
    major, minor = layout(types, symbol)
    return f"p:{group}/{symbol} {symbol} major=+{major}($arg1):u32 minor=+{minor}($arg1):u32 comm=$comm"

def save(output, receipt):
    output.write_text(json.dumps(receipt, indent=2))
    output.chmod(0o600)
    if output != STATE and os.environ.get("SUDO_UID", "").isdecimal():
        os.chown(output, int(os.environ["SUDO_UID"]), -1)

def unregister(state, receipt):
    instance = TRACE / "instances" / state["group"]
    if instance.exists():
        (instance / "tracing_on").write_text("0")
        for event in state["events"]:
            base = instance / "events" / state["group"] / event
            (base / "enable").write_text("0")
            if event == "lo_release":
                try: (base / "trigger").write_text("!stacktrace")
                except OSError: pass
        with (instance / "trace").open("rb") as stream: raw = stream.read(LIMIT + 1)
        path = pathlib.Path(state["output"]).with_suffix(".txt")
        path.write_bytes(raw[:LIMIT]); path.chmod(0o600)
        if os.environ.get("SUDO_UID", "").isdecimal(): os.chown(path, int(os.environ["SUDO_UID"]), -1)
        receipt["traceTruncated"] = len(raw) > LIMIT
        instance.rmdir()
    for event in state["events"]:
        with (TRACE / "kprobe_events").open("a") as stream: stream.write(f"-:{state['group']}/{event}\n")

def start(output):
    receipt = {"kernel": os.uname().release, "monoNs": time.monotonic_ns(), "availability": {symbol: "unavailable: admission not reached" for symbol in ("lo_open", "lo_release", "disk_force_media_change", "loop_control_ioctl")}, "clock": "mono", "device": "7:1790"}
    if STATE.exists(): raise RuntimeError("owned-loop trace state already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    state = {"group": "brainloop_" + uuid.uuid4().hex[:12], "events": [], "output": str(output)}
    receipt["group"] = state["group"]
    reserved = False
    save(output, receipt)
    try:
        # BTF is inspected before generating any pointer expression. Failure has no fallback.
        result = subprocess.run(["bpftool", "-j", "btf", "dump", "file", "/sys/kernel/btf/vmlinux", "format", "raw"], capture_output=True, timeout=10)
        if result.returncode or len(result.stdout) > 64 * 1024 * 1024: raise ValueError("live-btf-unavailable")
        types = json.loads(result.stdout)["types"]
        instance = TRACE / "instances" / state["group"]
        # Reserve the invocation state exclusively before touching tracefs.
        with STATE.open("x") as stream: json.dump(state, stream)
        reserved = True
        STATE.chmod(0o600)
        instance.mkdir()
        (instance / "tracing_on").write_text("0")
        (instance / "trace_clock").write_text("mono")
        (instance / "buffer_size_kb").write_text("64")
        # Return probes cannot safely recover entry arguments with this collector.
        receipt["availability"]["loop_control_ioctl:return"] = "unavailable: no admitted entry/return correlation"
        receipt["availability"]["openers"] = "unavailable: no admitted nested layout"
        for symbol in ("lo_open", "lo_release", "disk_force_media_change", "loop_control_ioctl"):
            phase = "live-layout"
            definition = None
            try:
                if symbol == "loop_control_ioctl":
                    # No pointer fields: the live prototype must still match before using args.
                    funcs = [x for x in types if x["kind"] == "FUNC" and x["name"] == symbol]
                    by_id = {x["id"]: x for x in types}
                    proto = by_id[funcs[0]["type_id"]] if len(funcs) == 1 else {}
                    if [p["name"] for p in proto.get("params", [])] != ["file", "cmd", "arg"]:
                        raise ValueError("ioctl-prototype-unavailable")
                    # Admit integer widths from actual BTF, rather than assuming an ABI.
                    for parameter, width in zip(proto["params"][1:], (4, 8)):
                        kind = by_id[parameter["type_id"]]
                        if kind["kind"] != "INT" or kind["size"] != width: raise ValueError("ioctl-integer-layout")
                    definition = f"p:{state['group']}/{symbol} {symbol} cmd=$arg2:u32 arg=$arg3:u64 comm=$comm"
                    predicate = "cmd == 19585 && arg == 1790"
                else:
                    definition = definitions(types, symbol, state["group"])
                    predicate = "major == 7 && minor == 1790"
                phase = "registration"
                with (TRACE / "kprobe_events").open("a") as stream: stream.write(definition + "\n")
                state["events"].append(symbol)
                # Persist ownership before further admission or enabling.
                save(STATE, state)
                base = instance / "events" / state["group"] / symbol
                phase = "registered-fields"
                format_text = (base / "format").read_text()
                fields = ("cmd", "arg", "comm") if symbol == "loop_control_ioctl" else ("major", "minor", "comm")
                if any(" " + field + ";" not in format_text and " " + field + "[" not in format_text for field in fields):
                    raise ValueError("registered-fields-unavailable")
                phase = "filter-and-trigger"
                (base / "filter").write_text(predicate)
                if symbol == "lo_release": (base / "trigger").write_text("stacktrace if " + predicate)
                (base / "enable").write_text("1")
                receipt["availability"][symbol] = {"admitted": True, "definition": definition, "filter": predicate}
            except (OSError, ValueError, KeyError, IndexError) as error:
                receipt["availability"][symbol] = {"unavailable": type(error).__name__, "errno": getattr(error, "errno", None),
                                                     "phase": phase, "definition": definition,
                                                     "reason": str(error) if isinstance(error, ValueError) else "kernel-or-filesystem-rejected"}
        save(STATE, state)
        (instance / "tracing_on").write_text("1")
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        receipt["unavailable"] = {"reason": type(error).__name__, "errno": getattr(error, "errno", None)}
        if reserved:
            try: unregister(state, receipt)
            except OSError as cleanup: receipt["cleanupUnknown"] = type(cleanup).__name__
            else: STATE.unlink(missing_ok=True)
    save(output, receipt)

def stop():
    if not STATE.exists(): return
    state = json.loads(STATE.read_text())
    output = pathlib.Path(state["output"])
    receipt = json.loads(output.read_text())
    try:
        unregister(state, receipt)
        STATE.unlink()
        receipt["stoppedMonoNs"] = time.monotonic_ns()
    except OSError as error: receipt["cleanupUnknown"] = {"reason": type(error).__name__, "errno": error.errno}
    save(output, receipt)

def interrupted(signum, _frame):
    raise OSError("trace admission interrupted")

if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    if sys.argv[1:] == ["stop"]: stop()
    elif len(sys.argv) == 3 and sys.argv[1] == "start": start(pathlib.Path(sys.argv[2]).resolve())
    else: raise SystemExit("usage: loop-trace.py start <receipt.json>|stop")
