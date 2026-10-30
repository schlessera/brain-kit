"""Bounded container-only snapshot after owned LOOP_CTL_REMOVE returned EBUSY.

Never open the device, inspect descriptors, or export mount paths/options.
The caller imposes a separate hard process deadline.
"""
import json, os, pathlib, time

MAX_PIDS = 128
MAX_READ = 16384
MAX_MOUNTS = 16

def unknown(error):
    return {"unknown": type(error).__name__, "errno": getattr(error, "errno", None)}

def read(path):
    try:
        with path.open("rb") as stream: raw = stream.read(MAX_READ + 1)
        return {"text": raw[:MAX_READ].decode(errors="replace"), "truncated": len(raw) > MAX_READ}
    except OSError as error: return unknown(error)

def sysfs(root):
    base = root / "block/loop1790"
    result = {"monoNs": time.monotonic_ns(), "device": read(base / "dev"), "size": read(base / "size")}
    # Only presence, never the backing filename.
    try:
        (base / "loop/backing_file").stat()
        result["backingAttribute"] = "present"
    except FileNotFoundError: result["backingAttribute"] = "absent"
    except OSError as error: result["backingAttribute"] = unknown(error)
    try:
        with os.scandir(base / "holders") as entries:
            count = sum(1 for _, _entry in zip(range(17), entries))
        result["holders"] = {"count": min(count, 16), "truncated": count > 16}
    except OSError as error: result["holders"] = unknown(error)
    return result

def collect(proc=pathlib.Path("/proc"), sys=pathlib.Path("/sys"), budget=0.5):
    deadline = time.monotonic() + budget
    result = {"device": "7:1790", "before": sysfs(sys), "processes": [], "truncated": False}
    try:
        with os.scandir(proc) as entries:
            for entry in entries:
                if not entry.name.isdecimal(): continue
                if len(result["processes"]) >= MAX_PIDS or time.monotonic() >= deadline:
                    result["truncated"] = True
                    break
                base = proc / entry.name
                status = read(base / "status")
                row = {"pid": int(entry.name), "status": {"unknown": "unsupported"}}
                if "text" in status:
                    fields = dict(line.split(":", 1) for line in status["text"].splitlines() if ":" in line)
                    row["status"] = {key: fields.get(key, "unknown: absent").strip()[:64] for key in ("Name", "Uid", "State")}
                    row["statusTruncated"] = status["truncated"]
                else: row["status"] = status
                try:
                    ns = os.readlink(base / "ns/mnt")
                    row["mountNamespace"] = ns if ns.startswith("mnt:[") and ns.endswith("]") and ns[5:-1].isdecimal() else {"unknown": "unsupported"}
                except OSError as error: row["mountNamespace"] = unknown(error)
                mounts = read(base / "mountinfo")
                if "text" not in mounts: row["mounts"] = mounts
                else:
                    facts = []
                    malformed = False
                    for line in mounts["text"].splitlines():
                        parts = line.split()
                        try:
                            separator = parts.index("-")
                            device, fs = parts[2], parts[separator + 1]
                            if device == "7:1790" or fs in ("btrfs", "overlay"):
                                facts.append({"ownedDevice": device == "7:1790", "filesystem": fs if fs in ("btrfs", "overlay") else "other", "paths": "redacted"})
                        except (ValueError, IndexError): malformed = True
                    row["mounts"] = {"facts": facts[:MAX_MOUNTS], "truncated": mounts["truncated"] or len(facts) > MAX_MOUNTS, "malformed": malformed}
                result["processes"].append(row)
    except OSError as error: result["procUnknown"] = unknown(error)
    result["after"] = sysfs(sys)
    return result

if __name__ == "__main__":
    print(json.dumps(collect(), ensure_ascii=True))
