import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

export function registerNetworkApprovalStackDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

registerNetworkApprovalStackDom();

export async function unregisterNetworkApprovalStackDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) {
    await act(async () => {});
    await GlobalRegistrator.unregister();
  }
}
