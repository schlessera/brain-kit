/// <reference types="@vitest/browser-playwright" />
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { SESSION, installConsumerStyles, scene, controlledMicrophone } from "./conversation-scene.js";



installConsumerStyles();

/** A PCM16 frame below the client's speaking threshold (RMS 0.015). */
function silent(pcm: string) {
  const bytes = Uint8Array.from(atob(pcm), char => char.charCodeAt(0)), view = new DataView(bytes.buffer);
  let energy = 0;
  for (let i = 0; i < bytes.length; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
  return Math.sqrt(energy / (bytes.length / 2)) <= 0.015;
}

// Real AudioWorklet capture and playback exercise the interval before the
// natural 700 ms endpoint. Provider frames remain entirely offline.
for (const action of ["send", "discard", "answer", "mute"] as const) for (const noisy of [false, true]) test(`manual ${action}: ${noisy ? "bounded noisy deadline" : "quiet recovery"} after interrupted speech`, async ctx => {
  const mic = controlledMicrophone(ctx, true);
  const s = await scene(ctx); await s.start(); mic.quiet();
  await expect.poll(() => s.socket.frames("conversation_endpoint").length).toBe(1);
  const bytes = new Uint8Array(48000), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 2; i++) view.setInt16(i * 2, Math.sin(i * 2 * Math.PI * 440 / 24000) * 6000, true);
  const pcm = btoa(String.fromCharCode(...bytes));
  let sequence = 0;
  const audio = () => s.event({ kind: "audio", outputId: "ithaca-manual-interruption", sequence: sequence++, pcm, format: { encoding: "pcm16", channels: 1, sampleRate: 24000 } });
  audio();
  await expect.poll(() => s.client.state.getState().playing).toBe(true);
  mic.speak();
  await expect.poll(() => s.client.state.getState().outputRecovery).toBe("speaking");
  const quietFrom = s.socket.frames("conversation_audio").length;
  mic.quiet();
  // Drain queued real microphone blocks, still before the 700 ms endpoint.
  // Blocks arrive in order, so the first frame below the client's speaking
  // threshold follows every speaking block queued before quiet().
  await expect.poll(() => s.socket.frames("conversation_audio").slice(quietFrom).some(frame => silent(String(frame.pcm)))).toBe(true);
  if (action === "answer") {
    s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "Which departure works?" });
    s.deliver({ type: "ask_user_request", sessionId: SESSION, turnId: "ithaca-turn", requestId: "ithaca-question", questions: [{ question: "Which day?", header: "Day", multiSelect: false, options: [{ label: "Tomorrow", description: "Before departure" }] }] });
  }
  s.input("Tomorrow before departure");
  await expect.poll(() => s.button(action === "discard" ? "Discard draft" : action === "mute" ? "Mute" : "Send now")).not.toBeUndefined();
  expect(s.socket.frames("conversation_endpoint")).toHaveLength(1);
  expect(s.client.state.getState().outputRecovery).toBe("speaking");
  let noise: ReturnType<typeof setInterval> | undefined;
  if (noisy) { audio(); noise = setInterval(audio, 60); ctx.onTestFinished(() => clearInterval(noise)); }
  await userEvent.click(s.button(action === "discard" ? "Discard draft" : action === "mute" ? "Mute" : "Send now"));
  expect(s.client.state.getState().outputRecovery, "MANUAL_ENDPOINT_STARTS_RECOVERY").toBe("checking");
  expect(s.socket.frames("conversation_endpoint")).toHaveLength(2);
  expect(s.socket.frames("conversation_commit")).toHaveLength(action === "send" ? 1 : 0);
  expect(s.socket.frames("ask_user_response")).toHaveLength(action === "answer" ? 1 : 0);
  if (action === "answer") expect(s.socket.frames("ask_user_response")[0]?.answers).toEqual({ "Which day?": "Tomorrow before departure" });
  if (action === "discard") {
    // A discarded final cannot return later and arrange an automatic send.
    s.input("Tomorrow before departure", "final");
    expect(s.client.state.getState().text).toBe("");
  }
  await expect.poll(() => s.client.state.getState().outputRecovery, { timeout: 4200, message: "MANUAL_ENDPOINT_HAS_BOUNDED_RECOVERY" }).toBe(noisy ? "muted" : "audible");
  clearInterval(noise);
  expect(s.client.state.getState().micOn).toBe(action !== "mute");
  expect(s.socket.frames("conversation_stop")).toHaveLength(0);
  if (noisy) { await userEvent.click(s.button("Recover reply audio")); expect(s.client.state.getState().outputRecovery).toBe("audible"); }
  audio(); await expect.poll(() => s.client.state.getState().playing).toBe(true);
  if (action !== "mute") { mic.speak(); await expect.poll(() => s.socket.frames("conversation_audio").at(-1)?.utteranceId).not.toBe(s.socket.frames("conversation_endpoint").at(-1)?.utteranceId); }
  else { expect(mic.opens()).toBe(1); expect(s.socket.frames("conversation_commit")).toHaveLength(0); }
});
