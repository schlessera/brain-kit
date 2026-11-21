/** Fixture-only metadata access for the guard before the identity handoff. */
export const PRIVATE_FIXTURE_DIRECTORY_ACCESS = `import json,os,stat,struct,sys
root,owner,reader=sys.argv[1:]
owner,reader=int(owner),int(reader)
assert owner!=reader
changed=[]
for directory,dirs,files in os.walk(root,followlinks=False):
    info=os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=owner or info.st_mode & 0o077:
        continue
    # Preserve owner access; only this named reader gets metadata traversal.
    # No file ACLs change, and neither the owning group nor others get access.
    entries=[(1,(info.st_mode >> 6) & 7,0xffffffff),(2,5,reader),(4,0,0xffffffff),(16,5,0xffffffff),(32,0,0xffffffff)]
    acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
    os.setxattr(directory,'system.posix_acl_access',acl,follow_symlinks=False)
    changed.append(os.path.relpath(directory,root))
print(json.dumps({'fixtureDirectoryReader':reader,'owner':owner,'directories':changed}))
`;
