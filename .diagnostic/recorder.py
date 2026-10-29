"""Temporary compact observation measurement; no writes between paired reads."""
import fcntl as _trace_fcntl
import json, os, sys, time, uuid

TRACE_LIMIT = 8 * 1024 * 1024
ARM = "/proof/diagnostic-arm.json"
TRACE = "/proof/diagnostic-trace"

def differences(before, after, path=""):
    if isinstance(before, dict) and isinstance(after, dict):
        result = []
        for key in sorted(set(before) | set(after)):
            child = path+"."+key if path else key
            if key not in before or key not in after:
                result.append({"path": child, "before_present": key in before, "after_present": key in after,
                               "before": before.get(key), "after": after.get(key)})
            else:
                result.extend(differences(before[key], after[key], child))
        return result
    return [] if before == after else [{"path": path, "before": before, "after": after}]

class Recorder:
    def __init__(self, original, context):
        self.original, self.context = original, context
        self.items, self.sync_start, self.sync_done = [], None, None
        self.arm = None
        if os.path.exists(ARM):
            with open(ARM, encoding="utf8") as source:
                value = json.load(source)
            if context and value["worktreeId"] == context.get("from"):
                self.arm = value
    def snapshot(self, *args):
        began = {"wall_ns": time.time_ns(), "mono_ns": time.monotonic_ns()}
        value = self.original(*args)
        ended = {"wall_ns": time.time_ns(), "mono_ns": time.monotonic_ns()}
        if len(self.items) >= 8:
            raise RuntimeError("DIAGNOSTIC_SNAPSHOT_BOUND")
        self.items.append({"began": began, "ended": ended, "value": value})
        return value
    def finish(self, ns):
        stable = self.items[-2]["value"] == self.items[-1]["value"] if len(self.items) >= 2 else None
        row = {"version": 1, "observation_id": uuid.uuid4().hex,
               "synthetic": ns.get("_diag_synthetic", False), "armed": self.arm is not None,
               "operation": self.context or {"operation": None, "id": None, "from": None},
               "reads": ns.get("reads"), "stable": stable, "fsid": ns["fsid"],
               "sync_start_ns": self.sync_start, "sync_done_ns": self.sync_done,
               "finished_mono_ns": time.monotonic_ns(), "finished_wall_ns": time.time_ns(),
               "exception": str(sys.exc_info()[1]) if sys.exc_info()[0] else None}
        # Stable two-read unarmed observations are summaries. Every unequal pair and every armed pair is retained.
        if self.arm is not None or not stable or ns.get("reads", 0) > 2:
            pairs = []
            for offset in range(0, len(self.items)-1, 2):
                a, b = self.items[offset:offset+2]
                delta = differences(a["value"], b["value"])
                pairs.append({"index": offset//2+1, "first_began": a["began"], "first_ended": a["ended"],
                              "second_began": b["began"], "second_ended": b["ended"],
                              "equal": not delta, "first_difference": delta[0]["path"] if delta else None,
                              "differences": delta, "first_dropping": a["value"]["dropping"],
                              "second_dropping": b["value"]["dropping"],
                              "first_subvolumes_count": len(a["value"]["subvolumes"]),
                              "second_subvolumes_count": len(b["value"]["subvolumes"])})
            row["pairs"] = pairs
        if self.arm is not None:
            row.update(arm=self.arm, pool=ns["pool"], helper_pid=os.getpid())
        data = (json.dumps(row, sort_keys=True, separators=(",", ":"))+"\n").encode()
        os.makedirs(TRACE, mode=0o755, exist_ok=True)
        fd = os.open(os.path.join(TRACE, "observations.jsonl"), os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW, 0o644)
        try:
            _trace_fcntl.flock(fd, _trace_fcntl.LOCK_EX)
            if os.fstat(fd).st_size+len(data) > TRACE_LIMIT:
                raise RuntimeError("DIAGNOSTIC_TRACE_BUDGET")
            remaining = memoryview(data)
            while remaining:
                written = os.write(fd, remaining)
                if written <= 0:
                    raise RuntimeError("DIAGNOSTIC_SHORT_WRITE")
                remaining = remaining[written:]
            os.fchmod(fd, 0o644); os.chmod(TRACE, 0o755)
            os.fsync(fd)
        finally:
            os.close(fd)

_diag_context = json.loads(sys.argv[5]) if len(sys.argv) > 5 else None
_diag = Recorder(snapshot, _diag_context)
snapshot = _diag.snapshot
