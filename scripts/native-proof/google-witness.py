"""Fixed offline witness of the host's Google credential boundary (#4206), run inside actual native workers.

argv[1] is a JSON object the host test wrote:
  homes:      {name: path} of directories that hold Google credentials on the host
  identities: {name: [st_dev, st_ino]} of those directories as the host sees them
  files:      {name: path} of canary files planted in them
  canary:     the secret the host gog process holds in its environment

It prints one JSON object and asserts nothing itself, so the host test names
each claim that fails. It also looks where a gog or `brain google` started in
this worker would look: its own HOME's gog default and its own standalone
default under XDG_DATA_HOME.
"""
import errno
import json
import os
import re
import sys

spec = json.loads(sys.argv[1])
canary = spec["canary"].encode()
GOOGLE_NAME = re.compile(r"^(GOG_|BRAIN_UI_GOOGLE_|BRAIN_GOOGLE_)")


def code(error):
    return errno.errorcode.get(error.errno, str(error.errno))


def view(path, identity):
    """What this worker learns about one directory: whether it stats, what it lists, and whether it is the host's."""
    try:
        info = os.stat(path)
    except OSError as error:
        return {"stat": code(error), "entries": None, "hostInode": False}
    try:
        entries = sorted(os.listdir(path))
    except OSError as error:
        entries = code(error)
    return {"stat": "ok", "entries": entries, "hostInode": identity is not None and [info.st_dev, info.st_ino] == identity}


def readable(path):
    try:
        with open(path, "rb") as handle:
            return canary in handle.read()
    except OSError:
        return False


home = os.environ.get("HOME", "")
data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
own = {"workerGogDefault": os.path.join(home, ".config", "gogcli"), "workerStandalone": os.path.join(data, "brain", "google")}
homes = {name: view(path, spec["identities"].get(name)) for name, path in {**spec["homes"], **own}.items()}
files = {name: readable(path) for name, path in spec["files"].items()}

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
    "procEnvironCanary": environ_hits,
    "procEnvironScanned": scanned,
}))
