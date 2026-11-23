"""Fixed offline witness of the host's Google credential boundary (#4206), run inside actual native workers.

argv[1] is a JSON object the host test wrote:
  homes:      {name: path} of directories that hold Google credentials on the host
  identities: {name: [st_dev, st_ino]} of those directories as the host sees them
  files:      {name: path} of canary files planted in them
  canary:     the secret the host gog process holds in its environment
  fixture:    the host directory every Google setting points into

It prints one JSON object and asserts nothing itself, so the host test names
each claim that fails. It also looks where a gog or `brain google` started in
this worker would look: gog's own default configuration and data directories
and the standalone default under XDG_DATA_HOME. The scan's wall-clock start
and end let the host test show its own gog was alive throughout.
"""
import errno
import json
import os
import re
import sys
import time

started = time.time() * 1000
spec = json.loads(sys.argv[1])
canary = spec["canary"].encode()
GOOGLE_NAME = re.compile(r"^(GOG_|BRAIN_UI_GOOGLE_|BRAIN_GOOGLE_|BRAIN_UI_GOG_PATH$)")


def code(error):
    return errno.errorcode.get(error.errno, str(error.errno))


def outcome(call, path):
    try:
        call(path)
        return "ok"
    except OSError as error:
        return code(error)


def mounts():
    """This worker's mount table: mount point -> the filesystem type of the topmost mount there."""
    table = {}
    with open("/proc/self/mountinfo") as handle:
        for line in handle:
            left, _, right = line.partition(" - ")
            point = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), left.split(" ")[4])
            table[point] = right.split(" ")[0]
    return table


MOUNTS = mounts()


def view(path, identity):
    """What this worker learns about one directory: stat and lstat, what it lists, whether it is the host's, and what is mounted there."""
    seen = {"stat": outcome(os.stat, path), "lstat": outcome(os.lstat, path), "entries": None, "hostInode": False, "fstype": MOUNTS.get(path)}
    if seen["stat"] != "ok":
        return seen
    info = os.stat(path)
    try:
        seen["entries"] = sorted(os.listdir(path))
    except OSError as error:
        seen["entries"] = code(error)
    seen["hostInode"] = identity is not None and [info.st_dev, info.st_ino] == identity
    return seen


def file_view(path):
    """One canary file: whether it stats or lstats at all, and whether its bytes are readable."""
    read = False
    try:
        with open(path, "rb") as handle:
            read = canary in handle.read()
    except OSError:
        pass
    return {"stat": outcome(os.stat, path), "lstat": outcome(os.lstat, path), "read": read}


def base(variable, *fallback):
    """An XDG base directory as gog and `brain google` resolve it: the variable when absolute, else under HOME."""
    value = os.environ.get(variable, "")
    return value if os.path.isabs(value) else os.path.join(os.environ.get("HOME", ""), *fallback)


config, data = base("XDG_CONFIG_HOME", ".config"), base("XDG_DATA_HOME", ".local", "share")
own = {"workerGogDefault": os.path.join(config, "gogcli"), "workerGogDefaultData": os.path.join(data, "gogcli"), "workerStandalone": os.path.join(data, "brain", "google")}
homes = {name: view(path, spec["identities"].get(name)) for name, path in {**spec["homes"], **own}.items()}
files = {name: file_view(path) for name, path in spec["files"].items()}

environ_hits, scanned = [], 0
for entry in os.listdir("/proc"):
    if not entry.isdigit():
        continue
    try:
        with open(os.path.join("/proc", entry, "environ"), "rb") as handle:
            held = handle.read()
    except OSError:
        continue
    scanned += 1
    if canary in held:
        environ_hits.append(int(entry))

print(json.dumps({
    "homes": homes,
    "files": files,
    "envNames": sorted(name for name in os.environ if GOOGLE_NAME.match(name)),
    "envCanary": any(spec["canary"] in value for value in os.environ.values()),
    "envFixture": any(spec["fixture"] in value for value in os.environ.values()),
    "procEnvironCanary": environ_hits,
    "procEnvironScanned": scanned,
    "scanStartedAt": started,
    "scanEndedAt": time.time() * 1000,
}))
