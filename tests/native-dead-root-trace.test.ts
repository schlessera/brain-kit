import { describe, expect, test } from "bun:test";
import { checkpointRoots, classifyDeadRoots, parseDeadRootTrace } from "../scripts/native-proof/dead-root-trace.ts";

// Excerpt shape from a real kernel trace; checkpoint names are fixture UUIDs.
const trace = `# kernel 6.18.0; probes: delete dead_root commit_async drop; clock mono
           <...>-1167    [030] ..... 100.000000: delete: (btrfs_delete_subvolume+0x4/0xb10 [btrfs]) name="aaaaaaaa-0000-4000-8000-000000000001" comm="btrfs"
           <...>-1167    [030] ..... 100.000050: dead_root: (btrfs_add_dead_root+0x4/0x140 [btrfs]) root=257 comm="btrfs"
           <...>-1167    [030] ..... 100.000055: <stack trace>
 => kprobe_trace_func
 => 0xffffffffc040e0f5
 => btrfs_add_dead_root
 => iput
 => btrfs_ioctl
           btrfs-1167    [030] ..... 100.000070: commit_async: (btrfs_commit_transaction_async+0x4/0x120 [btrfs]) comm="btrfs"
   btrfs-cleaner-900     [004] ..... 100.008000: drop: (btrfs_drop_snapshot+0x4/0x700 [btrfs]) root=257 comm="btrfs-cleaner"
           <...>-2709    [012] ..... 200.000000: delete: (btrfs_delete_subvolume+0x4/0xb10 [btrfs]) name="aaaaaaaa-0000-4000-8000-000000000002" comm="btrfs"
           btrfs-2709    [012] ..... 200.000060: commit_async: (btrfs_commit_transaction_async+0x4/0x120 [btrfs]) comm="btrfs"
           <...>-947     [003] ..... 229.976000: dead_root: (btrfs_add_dead_root+0x4/0x140 [btrfs]) root=258 comm="bun"
           <...>-947     [003] ..... 229.976010: <stack trace>
 => btrfs_add_dead_root
 => dput
 => __fput
   btrfs-cleaner-900     [004] ..... 231.400000: drop: (btrfs_drop_snapshot+0x4/0x700 [btrfs]) root=258 comm="btrfs-cleaner"
           <...>-3000    [001] ..... 300.000000: delete: (btrfs_delete_subvolume+0x4/0xb10 [btrfs]) name="aaaaaaaa-0000-4000-8000-000000000003" comm="btrfs"
           <...>-3001    [002] ..... 300.000020: dead_root: (btrfs_add_dead_root+0x4/0x140 [btrfs]) root=259 comm="bun"
           btrfs-3000    [001] ..... 300.000060: commit_async: (btrfs_commit_transaction_async+0x4/0x120 [btrfs]) comm="btrfs"
           <...>-3100    [001] ..... 400.000000: delete: (btrfs_delete_subvolume+0x4/0xb10 [btrfs]) name="aaaaaaaa-0000-4000-8000-000000000004" comm="btrfs"
           btrfs-3100    [001] ..... 400.000060: commit_async: (btrfs_commit_transaction_async+0x4/0x120 [btrfs]) comm="btrfs"
`;
const operations = [1, 2, 3, 4].flatMap(n => [
  { stage: "start", command: ["subvolume", "delete", "--commit-after", `/brain-fixture/.brain-native/checkpoints/aaaaaaaa-0000-4000-8000-00000000000${n}`] },
  { stage: "end", command: ["subvolume", "delete"], code: 0 },
  { stage: "start", command: ["subvolume", "sync", "/brain-fixture", String(256 + n)] },
].map(row => JSON.stringify(row))).join("\n");

describe("dead-root trace classification", () => {
  test("separates a delete-queued root from late and near-miss reference releases", () => {
    const rows = classifyDeadRoots(parseDeadRootTrace(trace), checkpointRoots(operations));
    expect(rows.map(row => [row.root, row.queue])).toEqual([["257", "with-delete"], ["258", "after-commit"], ["259", "other-before-commit"], ["260", "not-queued"]]);
    expect(rows[0]!.queuedBy?.stack).toEqual(["btrfs_add_dead_root", "iput", "btrfs_ioctl"]);
    expect(rows[0]!.droppedAfterDeleteMs).toBeCloseTo(8, 3);
    expect(rows[1]!.queuedBy).toMatchObject({ comm: "bun", pid: 947, stack: ["btrfs_add_dead_root", "dput", "__fput"] });
    expect(rows[1]!.queuedBy!.afterDeleteMs).toBeCloseTo(29_976, 3);
    expect(rows[1]!.droppedAfterDeleteMs).toBeCloseTo(31_400, 3);
    expect(rows[3]!.queuedBy).toBeUndefined();
  });
});
