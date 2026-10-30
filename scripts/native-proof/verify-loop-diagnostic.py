"""Validate observations, never infer admission from flags alone."""
import json, pathlib, re, sys

KERNEL = r"7\.0\.\d+(?:-[0-9]+)?-azure"

def require(condition, name):
    if not condition: raise ValueError(name)

def registration(receipt):
    require(re.fullmatch(KERNEL, receipt.get("kernel", "")), "KERNEL_NOT_7_0_AZURE")
    for name in ("lo_open", "lo_release"):
        row = receipt.get("availability", {}).get(name, {})
        require(row.get("admitted") is True and row.get("filter") == "major == 7 && minor == 1790" and row.get("stack") is True, "BOTH_PROBES_NOT_REGISTERED")

def events(text):
    rows, stacks = [], []
    current = None
    for line in text.splitlines():
        header = re.match(r"\s*(.*)-(\d+)\s+\[\d+\].*?\s(\d+\.\d+):\s+(.*)", line)
        if header:
            comm, pid, stamp, value = header.groups(); current = None
            if "<stack trace>" in value:
                current = dict(pid=int(pid), stamp=float(stamp), functions=[]); stacks.append(current)
            elif re.match(r"lo_(?:open|release):", value):
                major, minor = re.search(r"\bmajor=(\d+)", value), re.search(r"\bminor=(\d+)", value)
                require(major and minor, "EVENT_DEVICE_FIELDS_MISSING")
                require((int(major[1]), int(minor[1])) == (7, 1790), "FOREIGN_DEVICE_EVENT")
                task = re.search(r'\bcomm=(?:"([^"]*)"|(\S+))', value)
                require(task, "EVENT_COMM_MISSING")
                rows.append(dict(pid=int(pid), stamp=float(stamp), kind=value.split(":")[0], comm=task[1] or task[2], stack=[]))
        elif current is not None and "=>" in line: current["functions"].append(line.split("=>", 1)[1].strip())
    for stack in stacks:
        matches = [row for row in rows if row["pid"] == stack["pid"] and abs(row["stamp"] - stack["stamp"]) <= 0.01]
        if matches:
            nearest = min(matches, key=lambda row: abs(row["stamp"] - stack["stamp"]))
            nearest["stack"].extend(stack["functions"])
    return rows

def validate(receipt, raw, mode, fixture=None, witness=None):
    registration(receipt)
    if mode == "registration": return dict(status="REGISTRATION_ONLY_NOT_RUNTIME_ADMISSION")
    require("stoppedMonoNs" in receipt, "TRACE_STOP_UNCONFIRMED")
    require(raw.get("truncated") is False, "TRACE_EXPORT_TRUNCATED")
    rows = events(raw["trace"])
    require(rows and all(row["stack"] for row in rows), "ACTUAL_EVENTS_AND_STACKS_REQUIRED")
    if mode == "product":
        require(any(row["kind"] == "lo_open" and row["comm"] == "mount" and re.search(r"btrfs|mount_bdev", " ".join(row["stack"])) for row in rows), "OWNED_MOUNT_OPEN_STACK_REQUIRED")
        require(any(row["kind"] == "lo_release" and row["comm"] == "umount" and re.search(r"blkdev_put_whole|bdev_release|__fput", " ".join(row["stack"])) for row in rows), "OWNED_UNMOUNT_RELEASE_STACK_REQUIRED")
    else:
        require(mode == "held" and fixture and witness, "HELD_INPUTS_MISSING")
        remove = [r for r in fixture if r.get("kind") == "loop-boundary" and r.get("stage") == "remove-error"]
        require(len(remove) == 1 and remove[0].get("errno") == 16, "SINGLE_ORIGINAL_REMOVE_EBUSY_REQUIRED")
        ready = [r for r in fixture if r.get("kind") == "held-control" and r.get("phase") == "holder-ready"]
        ack = [r for r in fixture if r.get("kind") == "held-control" and r.get("phase") == "host-witness"]
        require(len(ready) == len(ack) == 1, "PIPE_AND_HOST_WITNESS_REQUIRED")
        require(ready[0]["pid"] == witness["containerPid"] and ready[0]["comm"] == witness["comm"] and ready[0]["start"] == witness["start"], "HELD_WITNESS_IDENTITY_MISMATCH")
        require(all(ack[0].get(key) == witness[key] for key in ("hostPid", "containerPid", "start", "comm")), "HELD_ACK_IDENTITY_MISMATCH")
        held = [r for r in rows if r["comm"] == witness["comm"] and r["pid"] == witness["hostPid"]]
        opened = [r for r in held if r["kind"] == "lo_open"]
        released = [r for r in held if r["kind"] == "lo_release"]
        boundary = remove[0]["monoNs"] / 1e9
        require(len(opened) == 1 and opened[0]["stamp"] < boundary, "HELD_OPEN_BEFORE_REMOVE_REQUIRED")
        require(len(released) == 1 and released[0]["stamp"] > boundary, "HELD_RELEASE_AFTER_REMOVE_REQUIRED")
        require(re.search(r"sys.*open|do_filp_open|path_openat", " ".join(opened[0]["stack"])), "HOLDER_OPEN_SYSCALL_STACK_REQUIRED")
        require(re.search(r"fput|close|release", " ".join(released[0]["stack"])), "HOLDER_CLOSE_STACK_REQUIRED")
        require(any(r.get("phase") == "owned-entry-removed" for r in fixture), "OWNED_CONTROL_ENTRY_CLEANUP_REQUIRED")
    return dict(status="OBSERVED_OWNED_LOOP_TRACE_ADMITTED", mode=mode, eventCount=len(rows), foreignObserved=0,
                limits=["Observer timing effect; no historical attribution", "No real foreign minor opened: synthetic negative only, requires reviewer acceptance"])

def main(args):
    mode, path = args[:2]; path = pathlib.Path(path)
    receipt = json.loads(path.read_text())
    raw = json.loads(path.with_suffix(".trace.json").read_text()) if mode != "registration" else None
    fixture = witness = None
    if mode == "held":
        directory = pathlib.Path(args[2]); fixture = json.loads((directory / "native-fixture.json").read_text()); witness = json.loads((directory / "holder-host-witness.json").read_text())
    result = validate(receipt, raw, mode, fixture, witness)
    path.with_suffix(".validation.json").write_text(json.dumps(result, indent=2)); print(json.dumps(result))

if __name__ == "__main__":
    try: main(sys.argv[1:])
    except Exception as error:
        print(json.dumps(dict(status="NOT_ADMITTED", failure=type(error).__name__, detail=str(error))))
        sys.exit(1)
