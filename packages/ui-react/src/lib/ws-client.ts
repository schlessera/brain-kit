import type { ClientMessage, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (status: "connecting" | "connected" | "disconnected") => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: MessageHandler;
  private onStatusChange: StatusHandler;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    url: string,
    onMessage: MessageHandler,
    onStatusChange: StatusHandler
  ) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  connect() {
    this.closed = false;
    this.onStatusChange("connecting");

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.onStatusChange("connected");
      };

      this.ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as ServerMessage;
          this.onMessage(msg);
        } catch {
          console.error("[ws] Failed to parse message:", evt.data);
        }
      };

      this.ws.onclose = () => {
        this.onStatusChange("disconnected");
        if (!this.closed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        // onclose will fire after onerror
      };
    } catch {
      this.onStatusChange("disconnected");
      if (!this.closed) {
        this.scheduleReconnect();
      }
    }
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Skip the remaining backoff and reconnect immediately (e.g. when the
   * browser fires an `online` event). No-op if open/connecting or closed
   * deliberately.
   */
  reconnectNow() {
    if (this.closed) return;
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.connect();
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
