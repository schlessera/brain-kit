import { expect, test } from "bun:test";
import { nativeManagerRequest } from "../src/server/native-brain-manager-protocol.js";

// A single inode probe never inventories the directory. Keep file/list bounds.
test.each(["readCheckpoint", "readStage", "poolReadCheckpoint"])("%s admits deep bounded stat probes without widening inventories", operation => {
  const input = { operation, id: "11111111-1111-4111-8111-111111111111", path: Array.from({length:260},()=>"x").join("/"), maximum:0 };
  expect(nativeManagerRequest.safeParse({...input,action:"stat"}).success,"DEEP_ALIAS_STAT_CAN_BE_QUALIFIED").toBe(true);
  for(const action of ["file","list"]) expect(nativeManagerRequest.safeParse({...input,action}).success,"DEEP_INVENTORY_AND_CONTENT_BOUNDS_STAY_CLOSED").toBe(false);
  for(const path of ["../notes/raft.md","workspaces/../notes/raft.md","/notes/raft.md","workspaces/\0x"])
    expect(nativeManagerRequest.safeParse({...input,path,action:"stat"}).success,"STAT_PROBE_CANNOT_TRAVERSE_OR_ESCAPE").toBe(false);
});
