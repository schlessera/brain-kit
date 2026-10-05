import type { AsrClient, AsrClientOptions, AsrEvent } from "@schlessera/brain-ui-sdk/client";

/** Keyless example adapter: browser audio goes to the fixture's local socket. */
export class ExternalSpeechClient implements AsrClient {
  stream: MediaStream | null = null;
  private socket: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private closed = false;
  private finish: (() => void) | null = null;
  constructor(readonly options: AsrClientOptions) {}

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.closed) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    const socket = new WebSocket(this.options.session.url);
    this.socket = socket;
    socket.onmessage = ({ data }) => {
      if (this.closed) return;
      const message = JSON.parse(String(data)) as AsrEvent | { type: "drained" };
      if (message.type === "drained") this.finish?.();
      else this.options.onEvent(message);
    };
    socket.onerror = () => this.options.onError(new Error("Fixture speech socket failure"));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onclose = () => reject(new Error("Fixture speech socket closed during start"));
    });
    if (this.closed) return;
    const recorder = new MediaRecorder(stream);
    this.recorder = recorder;
    recorder.ondataavailable = ({ data }) => {
      if (!this.closed && data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(data);
    };
    recorder.start(50);
  }

  stop(): void {
    this.closed = true;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      if (this.recorder.state !== "inactive") this.recorder.stop();
      this.recorder = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.socket?.close();
    this.socket = null;
    this.finish?.();
    this.finish = null;
  }

  async drainAndStop(): Promise<void> {
    const recorder = this.recorder, socket = this.socket;
    if (!recorder || !socket || socket.readyState !== WebSocket.OPEN) { this.stop(); return; }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture speech drain timed out")), 2000);
        this.finish = () => { clearTimeout(timer); resolve(); };
        // MediaRecorder queues its final data event before the stop event.
        recorder.onstop = () => socket.send(JSON.stringify({ type: "finish" }));
        recorder.stop();
      });
    } finally { this.stop(); }
  }
}
