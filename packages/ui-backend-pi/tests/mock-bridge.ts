import type {
  AskUserResult,
  BackendBridge,
  PermissionDecision,
  PermissionRequest,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/server";

export interface MockBridge {
  bridge: BackendBridge;
  emitted: ServerMessage[];
  permissionCalls: PermissionRequest[];
  askUserCalls: Array<{ requestId: string }>;
}

/**
 * A BackendBridge stub for unit tests. `decision` controls what
 * requestPermission resolves to; `askUser` (when set) enables the ask_user tool.
 */
export function makeMockBridge(opts: {
  decision?: PermissionDecision;
  askUser?: AskUserResult;
} = {}): MockBridge {
  const emitted: ServerMessage[] = [];
  const permissionCalls: PermissionRequest[] = [];
  const askUserCalls: Array<{ requestId: string }> = [];

  const bridge: BackendBridge = {
    emit: (m) => emitted.push(m),
    requestPermission: async (req) => {
      permissionCalls.push(req);
      return opts.decision ?? { behavior: "allow" };
    },
    ...(opts.askUser
      ? {
          askUser: async (requestId: string) => {
            askUserCalls.push({ requestId });
            return opts.askUser!;
          },
        }
      : {}),
  };

  return { bridge, emitted, permissionCalls, askUserCalls };
}
