/** Fixed credential-free maintenance payload; repository code is never imported. */
export const CODE_CHANGE_PROGRAM = String.raw`
import base64, hashlib, json, os, re, stat, subprocess, sys, tempfile, zlib
root, maximum = sys.argv[1], int(sys.argv[2])
if root.startswith("@output/"): root = os.path.join(os.environ["BRAIN_ROOT"], root[8:])
request = json.loads(sys.stdin.buffer.readline())
env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_ATTR_NOSYSTEM": "1"}
def fail(reason):
    raise RuntimeError(reason)
def command(args, data=None, local_env=None):
    result = subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "--no-replace-objects"] + args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=local_env or env)
    if result.returncode: fail("Git receipt command refused: " + result.stderr.decode("utf8", "replace")[:500])
    return result.stdout
hexid = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
def oid(value):
    if not isinstance(value, str) or not hexid.fullmatch(value): fail("Unsupported Git object identity")
    return value
# The source's config is never installed in the working Git directory. Only
# bounded raw HEAD/ref data and its object directory are read. Gitlinks, linked
# worktrees are refused rather than silently losing evidence.
source = os.path.join(root, ".git")
if not os.path.isdir(source) or os.path.islink(source): fail("Receipt requires an ordinary checkout Git directory")
for name in ["commondir"]:
    if os.path.lexists(os.path.join(source, name)): fail("Unsupported linked object store")
def bounded(path, maximum=1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum: fail("Invalid Git receipt metadata")
        return os.read(fd, maximum + 1)
    finally: os.close(fd)
head_raw = bounded(os.path.join(source, "HEAD")).decode("utf8").strip()
ref = None
if head_raw.startswith("ref: "):
    ref = head_raw[5:]
    if not ref.startswith("refs/") or any(p in ["", ".", ".."] for p in ref.split("/")): fail("Invalid HEAD reference")
    command(["check-ref-format", ref])
    try: commit = bounded(os.path.join(source, ref)).decode("ascii").strip()
    except FileNotFoundError:
        commit = None
        for line in bounded(os.path.join(source, "packed-refs")).decode("utf8").splitlines():
            if line.endswith(" " + ref): commit = line.split(" ")[0]
        if commit is None: fail("Unborn or unreadable checkout HEAD")
else: commit = head_raw
oid(commit)
with tempfile.TemporaryDirectory(prefix="code-receipt-") as scratch:
    repository = os.path.join(scratch, "evidence.git")
    command(["init", "--bare", "--object-format=" + ("sha256" if len(commit) == 64 else "sha1"), "-q", repository])
    args = ["--git-dir=" + repository, "--work-tree=" + root]
    # Temporary borrowing exists only inside this maintenance invocation. The
    # returned non-thin pack includes every reachable endpoint object.
    env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = os.path.join(source, "objects")
    def git(*values, data=None): return command(args + list(values), data)
    if request.get("pack_stream"):
        # The worker owns this private temporary copy. Only stdin crosses the
        # UID boundary; the journal's 0600 objects are never worker mounts.
        with tempfile.TemporaryFile() as previous_pack:
            digest = hashlib.sha256()
            while chunk := sys.stdin.buffer.read(64 * 1024):
                previous_pack.write(chunk); digest.update(chunk)
            if digest.hexdigest() != request["pack_hash"]: fail("Previous endpoint pack checksum changed")
            previous_pack.seek(0)
            result = subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--git-dir=" + repository, "unpack-objects", "-q"], stdin=previous_pack, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            if result.returncode: fail("Previous endpoint unpack refused")
    elif request.get("pack"):
        git("unpack-objects", "-q", data=base64.b64decode(request["pack"], validate=True))
    tree_head = oid(git("rev-parse", commit + "^{tree}").decode().strip())
    tree_before = oid(request.get("tree_before", tree_head))
    git("read-tree", tree_head)
    try:
        exclude = bounded(os.path.join(source, "info/exclude"))
        with open(os.path.join(repository, "info/exclude"), "wb") as target: target.write(exclude)
    except FileNotFoundError: pass
    source_index = os.path.join(scratch, "source-index")
    with open(source_index, "wb") as target: target.write(bounded(os.path.join(source, "index"), 64 * 1024 * 1024))
    index_env = dict(env, GIT_INDEX_FILE=source_index)
    current_tracked = set(command(args + ["ls-files", "--cached", "-z"], local_env=index_env).split(b"\0")) - {b""}
    tracked = set(git("ls-tree", "-r", "--name-only", "-z", tree_head).split(b"\0")) - {b""}
    known_blobs = set()
    for line in git("ls-tree", "-r", "-z", tree_head).split(b"\0"):
        if line.startswith(b"160000 "): fail("Submodule receipts are unsupported")
        if line: known_blobs.add(line.split()[2])
    try:
        with open(os.path.join(repository, "info/attributes"), "wb") as target: target.write(bounded(os.path.join(source, "info/attributes")))
    except FileNotFoundError: pass
    candidates = set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split(b"\0")) - {b""}
    candidates |= tracked
    attributes = git("check-attr", "-z", "--stdin", "filter", "working-tree-encoding", data=b"\0".join(sorted(candidates)) + b"\0").split(b"\0")
    for i in range(2, len(attributes) - 1, 3):
        if attributes[i] not in [b"unspecified", b"unset"]: fail("Filter and encoding receipts are unsupported")
    entries, total, inventory = [], 0, []
    for raw in sorted(candidates):
        path = raw.decode("utf8", "strict")
        parts = path.split("/")
        if any(p in ["", ".", "..", ".git"] for p in parts): fail("Invalid checkout path")
        parent, absent = root, False
        for part in parts[:-1]:
            parent = os.path.join(parent, part)
            try: info = os.lstat(parent)
            except FileNotFoundError:
                absent = True; break
            if stat.S_ISREG(info.st_mode):
                absent = True; break
            if not stat.S_ISDIR(info.st_mode): fail("Checkout path has a non-directory parent")
        absolute = os.path.join(root, path)
        try:
            if absent: raise FileNotFoundError()
            info = os.lstat(absolute)
            # A tracked leaf replaced by a directory is deleted; ls-files
            # supplies that directory's new leaves as separate candidates.
            if stat.S_ISDIR(info.st_mode): raise FileNotFoundError()
        except FileNotFoundError:
            entries.append(b"0 " + b"0" * len(commit) + b"\t" + raw + b"\0")
            continue
        if parts[-1] == ".gitmodules": fail("Submodule receipts are unsupported")
        if stat.S_ISLNK(info.st_mode):
            data = os.readlink(absolute).encode("utf8"); mode = "120000"
        elif stat.S_ISREG(info.st_mode):
            if info.st_size > maximum - total: fail("Checkout receipt exceeds byte bound")
            fd = os.open(absolute, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                opened = os.fstat(fd)
                if (opened.st_dev, opened.st_ino, opened.st_size) != (info.st_dev, info.st_ino, info.st_size): fail("Checkout changed during capture")
                with os.fdopen(fd, "rb", closefd=False) as file: data = file.read(maximum - total + 1)
            finally: os.close(fd)
            mode = "100755" if info.st_mode & 0o111 else "100644"
        else: fail("Unsupported checkout entry")
        inventory.append({"path": path, "bytes": len(data)})
        total += len(data)
        if total > maximum: fail("Checkout receipt exceeds byte bound")
        # Git's loose-object encoding avoids one process per tracked file. The
        # tree/pack plumbing below consumes and verifies these exact Git objects.
        encoded = b"blob " + str(len(data)).encode() + b"\0" + data
        blob = (hashlib.sha256(encoded) if len(commit) == 64 else hashlib.sha1(encoded)).hexdigest()
        if blob.encode() not in known_blobs:
            directory = os.path.join(repository, "objects", blob[:2])
            os.makedirs(directory, exist_ok=True)
            try:
                with open(os.path.join(directory, blob[2:]), "xb") as object_file: object_file.write(zlib.compress(encoded))
            except FileExistsError: pass
            known_blobs.add(blob.encode())
        entries.append(mode.encode() + b" " + blob.encode() + b"\t" + raw + b"\0")
    # Remove old leaves before adding their new parent/children.
    entries.sort(key=lambda entry: not entry.startswith(b"0 "))
    git("update-index", "-z", "--index-info", data=b"".join(entries))
    tree_after = oid(git("write-tree").decode().strip())
    paths, changed_bytes = [], 0
    diff = git("diff-tree", "--no-commit-id", "--no-renames", "--raw", "-r", "-z", tree_before, tree_after).split(b"\0")
    for i in range(0, len(diff) - 1, 2):
        meta, raw = diff[i], diff[i + 1]
        fields = meta.split()
        if len(fields) != 5: fail("Invalid tree diff")
        path = raw.decode("utf8", "strict")
        kind = {b"A": "added", b"D": "deleted", b"M": "modified", b"T": "modified"}.get(fields[-1])
        if not kind: fail("Unsupported tree change")
        paths.append({"path": path, "kind": kind, "untracked": raw not in current_tracked and kind == "added"})
        for endpoint in fields[2:4]:
            if endpoint != b"0" * len(commit): changed_bytes += int(git("cat-file", "-s", endpoint.decode()))
    pack = git("pack-objects", "--stdout", "--revs", data=(tree_before + "\n" + tree_after + "\n").encode())
    if len(pack) > maximum * 2 + 1024 * 1024: fail("Endpoint evidence exceeds byte bound")
    receipt = {"head_before": request.get("head_before", {"commit": commit, "ref": ref}), "head_after": {"commit": commit, "ref": ref}, "tree_before": tree_before, "tree_after": tree_after, "paths": paths, "bytes": changed_bytes, "untracked": sum(1 for p in paths if p["untracked"]), "ignore_changed": any(p["path"].split("/")[-1] == ".gitignore" for p in paths), "pack": base64.b64encode(pack).decode(), "inventory": inventory}
    if request.get("operation") == "revert":
        receipt.pop("pack"); receipt.pop("inventory")
        if tree_after != oid(request["expected_tree"]):
            current_diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", tree_before, tree_after, "--")
            try: current_preview = {"inline": True, "diff": current_diff.decode("utf8", "strict")} if len(current_diff) <= 256 * 1024 else {"inline": False, "reason": "size"}
            except UnicodeDecodeError: current_preview = {"inline": False, "reason": "binary"}
            print(json.dumps({"status": "conflict", "current": receipt, "expected": request["expected_tree"], "currentPreview": current_preview}))
            sys.exit(0)
        desired = {}
        for line in git("ls-tree", "-r", "-z", tree_before).split(b"\0"):
            if not line: continue
            meta, raw = line.split(b"\t", 1)
            mode, kind, blob = meta.split()
            desired[raw.decode("utf8")] = (mode, blob.decode())
        def parent_fd(path, create=False):
            parts = path.split("/")
            if any(p in ["", ".", "..", ".git"] for p in parts): fail("Invalid restore path")
            parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                for part in parts[:-1]:
                    try: child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    except FileNotFoundError:
                        if not create: raise
                        os.mkdir(part, 0o755, dir_fd=parent)
                        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    os.close(parent); parent = child
                return parent, parts[-1]
            except BaseException:
                os.close(parent); raise
        # Remove endpoint leaves first, then only the empty directories that
        # obstruct a desired leaf. Nonempty directories (including ignored
        # content) refuse structural replacement instead of losing that content.
        directories = set()
        for change in sorted(paths, key=lambda change: change["path"].count("/"), reverse=True):
            path = change["path"]
            if path in desired: continue
            try: parent, name = parent_fd(path)
            except FileNotFoundError: continue
            try:
                os.unlink(name, dir_fd=parent); os.fsync(parent)
            finally: os.close(parent)
            parts = path.split("/")
            blocking = next((count for count in range(1, len(parts)) if "/".join(parts[:count]) in desired), len(parts))
            for count in range(blocking, len(parts)): directories.add("/".join(parts[:count]))
        for directory in sorted(directories, key=lambda path: path.count("/"), reverse=True):
            parent, name = parent_fd(directory)
            try:
                os.rmdir(name, dir_fd=parent); os.fsync(parent)
            finally: os.close(parent)
        for change in paths:
            path = change["path"]
            if path not in desired: continue
            parent, name = parent_fd(path, create=True)
            try:
                try: existing = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError: existing = None
                if existing is not None and stat.S_ISDIR(existing.st_mode): os.rmdir(name, dir_fd=parent)
                mode, blob = desired[path]
                data = git("cat-file", "blob", blob)
                temporary = ".code-restore-" + os.urandom(16).hex()
                try:
                    if mode == b"120000": os.symlink(os.fsdecode(data), temporary, dir_fd=parent)
                    elif mode in [b"100644", b"100755"]:
                        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                        with os.fdopen(fd, "wb") as file:
                            file.write(data); file.flush(); os.fchmod(file.fileno(), 0o755 if mode == b"100755" else 0o644); os.fsync(file.fileno())
                    else: fail("Unsupported restore mode")
                    os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                finally:
                    try: os.unlink(temporary, dir_fd=parent)
                    except FileNotFoundError: pass
                os.fsync(parent)
            finally: os.close(parent)
        print(json.dumps({"status": "restored", "tree_before": tree_before, "tree_after": tree_after}))
    else: print(json.dumps(receipt))
`;

/** Bounded directory classification only; inspection turns never invoke it. */
export const CODE_CHECKOUT_LIST_PROGRAM = String.raw`
import json, os, stat, subprocess, sys
root = sys.argv[1]
result = []
env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
try:
    with os.scandir(root) as entries:
        for entry in entries:
            if len(result) >= 1024: raise RuntimeError("Too many writable checkouts")
            try:
                if not entry.is_dir(follow_symlinks=False): continue
                git = os.path.join(entry.path, ".git")
                mode = os.lstat(git).st_mode
                if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode)): continue
                # Resolve this exact .git, never discover a parent repository.
                # Git validates HEAD, common objects/refs and gitfile targets.
                found = subprocess.run(["/usr/bin/git", "rev-parse", "--resolve-git-dir", git], env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if found.returncode == 0: result.append("workspaces/" + entry.name)
            except OSError:
                # An unreadable or malformed marker leaves this directory in
                # ordinary file observation; it cannot abort peer discovery.
                continue
except FileNotFoundError: pass
print(json.dumps(sorted(result)))
`;

/** Preview uses only the owned pack; the source repository need not exist. */
export const CODE_CHANGE_PREVIEW_PROGRAM = String.raw`
import base64, json, os, re, subprocess, sys, tempfile
request = json.load(sys.stdin)
for key in ["tree_before", "tree_after"]:
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", request[key]): raise RuntimeError("Invalid endpoint")
env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_ATTR_NOSYSTEM": "1"}
with tempfile.TemporaryDirectory(prefix="code-preview-") as root:
    def git(*args, data=None):
        result = subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--git-dir=" + root] + list(args), env=env, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode: raise RuntimeError("Endpoint evidence unavailable")
        return result.stdout
    git("init", "--bare", "--object-format=" + ("sha256" if len(request["tree_before"]) == 64 else "sha1"), "-q")
    git("unpack-objects", "-q", data=base64.b64decode(request["pack"], validate=True))
    diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", request["tree_before"], request["tree_after"], "--")
    if len(diff) > 256 * 1024: print(json.dumps({"inline": False, "reason": "size"}))
    else:
        try: print(json.dumps({"inline": True, "diff": diff.decode("utf8", "strict")}))
        except UnicodeDecodeError: print(json.dumps({"inline": False, "reason": "binary"}))
`;
