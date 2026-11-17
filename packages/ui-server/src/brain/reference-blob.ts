/** Fixed offline Git-object reader. Its caller owns and attests the sealed acquisition root. */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const REFERENCE_BLOB_MAXIMUM = 4 * 1024 * 1024;
export const REFERENCE_BLOB_RANGE_MAXIMUM = 65_536;

export interface ReferenceBlobInput {
  /** Host-selected sealed acquisition, never a worker-supplied directory. */
  root: string;
  commit: string;
  tree: string;
  path: string;
  offset: number;
  maximum: number;
  signal?: AbortSignal;
}

/** Host evidence about the exact returned bytes; never a trust or private-access grant. */
export interface ReferenceBlob {
  bytes: Uint8Array;
  blob: string;
  mode: "100644" | "100755";
  tree: string;
  totalBytes: number;
  offset: number;
  length: number;
  /** SHA-256 of the returned range, including the empty range at EOF. */
  digest: string;
}

export function validReferenceBlobInput(input: ReferenceBlobInput): boolean {
  return typeof input.root === "string" && isAbsolute(input.root) && !input.root.includes("\0")
    && typeof input.commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commit)
    && typeof input.tree === "string" && input.tree.length === input.commit.length && /^[0-9a-f]+$/.test(input.tree)
    && typeof input.path === "string" && Buffer.byteLength(input.path) <= 4096 && !/[\\\u0000-\u001f\u007f]/u.test(input.path)
    && Buffer.from(input.path).toString("utf8") === input.path
    && input.path.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
    && Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= REFERENCE_BLOB_MAXIMUM
    && Number.isSafeInteger(input.maximum) && input.maximum >= 1 && input.maximum <= REFERENCE_BLOB_RANGE_MAXIMUM;
}

/**
 * Reads objects, never checkout files. Every subprocess has bounded stdout,
 * no stderr pipe to fill, literal arguments and no replace-object/pathspec
 * expansion. The ordinary maintenance envelope supplies network/UID limits.
 */
export const REFERENCE_BLOB_PROGRAM = String.raw`import base64,hashlib,json,os,subprocess,sys
binary,root,commit,tree,path,offset,maximum=sys.argv[1:]
offset=int(offset);maximum=int(maximum);limit=${REFERENCE_BLOB_MAXIMUM}
class Refusal(Exception):
 def __init__(self,code):self.code=code
def run(args,bound):
 child=subprocess.Popen([binary,"--no-replace-objects","--literal-pathspecs","--git-dir",os.path.join(root,".git"),"-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 try:
  data=child.stdout.read(bound+1)
  if len(data)>bound:raise Refusal("unavailable")
  if child.wait()!=0:raise Refusal("unavailable")
  return data
 finally:
  if child.poll() is None:child.kill();child.wait()
  child.stdout.close()
try:
 actual_tree=run(["rev-parse","--verify",commit+"^{tree}"],128).decode("ascii").strip()
 if actual_tree!=tree:raise Refusal("unavailable")
 entry=run(["ls-tree","--full-tree","-z",commit,"--",path],8192)
 rows=entry.split(b"\0")
 if len(rows)!=2 or rows[1] or not rows[0]:raise Refusal("invalid")
 fields=rows[0].split(b"\t",1)
 if len(fields)!=2 or fields[1]!=path.encode("utf-8"):raise Refusal("invalid")
 mode,kind,blob=fields[0].decode("ascii").split(" ")
 if mode not in ("100644","100755") or kind!="blob":raise Refusal("invalid")
 if len(blob)!=len(commit) or any(c not in "0123456789abcdef" for c in blob):raise Refusal("unavailable")
 raw_size=run(["cat-file","-s",blob],32)
 if not raw_size.endswith(b"\n") or not raw_size[:-1].isdigit():raise Refusal("unavailable")
 size=int(raw_size)
 if size>limit:raise Refusal("capacity")
 if offset>size:raise Refusal("invalid")
 content=run(["cat-file","blob",blob],limit)
 if len(content)!=size:raise Refusal("unavailable")
 object_hash=hashlib.sha1() if len(blob)==40 else hashlib.sha256()
 object_hash.update(b"blob "+str(size).encode("ascii")+b"\0"+content)
 if object_hash.hexdigest()!=blob:raise Refusal("unavailable")
 selected=content[offset:offset+maximum]
 print(json.dumps(dict(version=1,blob=blob,mode=mode,tree=tree,totalBytes=size,offset=offset,length=len(selected),digest=hashlib.sha256(selected).hexdigest(),base64=base64.b64encode(selected).decode("ascii")),separators=(",",":")))
except Refusal as error:
 print(json.dumps(dict(code=error.code),separators=(",",":")));sys.exit(1)
except Exception:
 print('{"code":"unavailable"}');sys.exit(1)
`;

/** Treat the worker's envelope as untrusted; JSON decoding must preserve exact bytes. */
export function parseReferenceBlob(text: string, input: ReferenceBlobInput): ReferenceBlob {
  if (Buffer.byteLength(text) > 2 * REFERENCE_BLOB_RANGE_MAXIMUM + 4096) throw Error("Immutable reference receipt exceeds its bound");
  const value = JSON.parse(text);
  if (!value || Object.keys(value).sort().join(",") !== "base64,blob,digest,length,mode,offset,totalBytes,tree,version"
    || value.version !== 1 || typeof value.blob !== "string" || value.blob.length !== input.commit.length || !/^[0-9a-f]+$/.test(value.blob)
    || !["100644", "100755"].includes(value.mode) || value.tree !== input.tree || value.offset !== input.offset
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < input.offset || value.totalBytes > REFERENCE_BLOB_MAXIMUM
    || value.length !== Math.min(input.maximum, value.totalBytes - input.offset)
    || typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest) || typeof value.base64 !== "string"
    || value.base64.length > Math.ceil(REFERENCE_BLOB_RANGE_MAXIMUM / 3) * 4) throw Error("Invalid immutable reference byte evidence");
  const bytes = Buffer.from(value.base64, "base64");
  if (bytes.length !== value.length || bytes.toString("base64") !== value.base64 || createHash("sha256").update(bytes).digest("hex") !== value.digest)
    throw Error("Invalid immutable reference range digest");
  return { bytes, blob: value.blob, mode: value.mode, tree: value.tree, totalBytes: value.totalBytes,
    offset: value.offset, length: value.length, digest: value.digest };
}
