# Android audio boundary measurement

Local experimental tooling for #1236 / #1010, outside published packages and
CI. This procedure requires a Linux x86_64 machine with KVM, Java, Python 3,
Node 24.21.0, npm, curl and unzip. It measures the existing `page.js` store;
it does not run the product or contact a provider. Fixture content is Odysseus,
2026-07-12. Never feed real speech, host microphone audio or account data.

## Prepare an isolated emulator

Read `android-pins.json` before installing. Versions below were checked against
Google repository metadata and npm on 2026-11-04. The T3 Device controller
requires agent-device **0.21.31** and expo-device-hub
**0.19.0-canary-20261023-1357114**. The issue's npm 0.21.36 observation is not
the controller pin. Keep doctor and controller versions distinct in findings.

Use the SDK root configured for the Device host, or configure the host to use
your dedicated SDK root. Do not replace another worker's SDK, AVD or daemon.
The following assumes an empty, owned SDK directory and already accepted
Android SDK licences; review/accept those licences through SDK Manager if
needed. No credentials or paid service are required.

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
mkdir -p "$ANDROID_HOME/cmdline-tools"
curl -fLo /tmp/odysseus-commandlinetools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
printf '%s  %s\n' 5fdcc763663eefb86a5b8879697aa6088b041e70 /tmp/odysseus-commandlinetools.zip | sha1sum -c -
unzip /tmp/odysseus-commandlinetools.zip -d "$ANDROID_HOME/cmdline-tools"
mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" 'platform-tools' 'emulator' 'system-images;android-35;google_apis;x86_64'
python3 scripts/probes/audio-commit-boundary/android-inventory.py "$ANDROID_HOME"
```

**Stop if inventory fails.** sdkmanager package names do not pin revisions.
The inventory requires emulator 37.2.13 (build 16740729), platform-tools 37.0.1,
command-line tools 19.0 and image revision 9 (Android 35, extension 13).
`android-pins.json` preserves exact upstream archive URLs and published SHA-1
checksums for reconstructing these inputs when the SDK catalogue advances;
archive recovery has not yet been independently exercised. Never silently use
a newer revision and label it the same experiment. Preserve a downloaded
archive and its own SHA-256 in your private evidence bundle when available.

Install the controller dependencies into dedicated external directories (never
add them to the project dependencies). For T3, use its supported tool installer
or its version-specific tool directories; `device_list` must acknowledge them.
Installing npm packages alone is not proof the running controller uses them.

```sh
npm install --prefix /tmp/odysseus-agent-device --save-exact agent-device@0.21.31
npm install --prefix /tmp/odysseus-device-hub --save-exact expo-device-hub@0.19.0-canary-20261023-1357114
printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd --name odysseus_audio_api35 --package 'system-images;android-35;google_apis;x86_64' --device pixel_6
sg kvm -c 'python3 -c '\''import os,fcntl; f=os.open("/dev/kvm",os.O_RDWR); print(fcntl.ioctl(f,0xAE00,0)); os.close(f)'\'''
sg kvm -c '"$ANDROID_HOME/emulator/emulator" -avd odysseus_audio_api35 -no-window -no-audio -no-snapshot -gpu swiftshader -accel on -no-boot-anim'
```

KVM API must be 12. The foreground emulator command owns its lifetime; keep
it in an owned terminal. `-no-audio` deliberately prevents host speech input.
This baseline has **no established deterministic microphone**. It must not be
used for audio measurements until a seeded virtual input is configured and
verified through `getUserMedia`, including decoded non-silent sample evidence.
A fake browser track cannot prove an OS microphone interruption.

For stale inherited supplementary groups, `sg kvm` refreshes access without
sudo. Apply that context to the Device service's supported launcher too if it
will boot the emulator. Do not kill/restart someone else's hub or daemon.
Inspect inherited `ADB_SERVER_SOCKET`, `ANDROID_ADB_SERVER_ADDRESS` and
`ANDROID_ADB_SERVER_PORT`; an unavailable remote endpoint prevents discovery.
Remove unintended remote overrides in the **owned local launch environment**,
not in shared configuration. Keep remote endpoint values out of public logs.

Run doctor with the exact installed binary, SDK PATH and refreshed context:

```sh
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
sg kvm -c 'node /tmp/odysseus-agent-device/node_modules/agent-device/bin/agent-device.mjs doctor --platform android --json'
```

Inspect `data.status` and every check: an outer `success:true` / process exit 0
can still contain `data.status:"fail"`. It is not a passing doctor receipt.
Record the installed Chrome version after discovery; the image's browser has
not been independently pinned or qualified yet. Do not sign into Google Play.

## Mandatory visible Device session

1. Call `device_list`. When a local Android device is present, pass its actual
   id **and** `hostId:"local"` to `device_open`.
2. Use the exact session-bound command returned by `device_open` for every
   app open/relaunch, deep link, tap, text, permission, setting, screenshot and
   recording. Read its `help <command>` first. Open the discovered browser
   app before snapshots or input. Do not copy a session from another thread.
3. Call `device_screenshot` to inspect the device. Save a screenshot through
   the bound command for each cell. A host file alone is not Device proof.
4. If a tool fails, preserve the exact error and follow its advice once. If
   it still fails, stop device work and hand off; never substitute adb input,
   direct CDP browser automation, a second controller or manual taps.

ADB remains usable for installation, logs and forwarding. It must not be used
for app interaction. Once the visible session is working, forward the fixture:

```sh
node scripts/probes/audio-commit-boundary/android-server.mjs /tmp/odysseus-audio-results
"$ANDROID_HOME/platform-tools/adb" reverse tcp:8765 tcp:8765
```

Use the bound command's URL-opening facility to open
`http://127.0.0.1:8765/` in the browser. The server binds loopback only and
writes bounded JSON receipts; it has no upload/transcription endpoint. It
serves the unchanged desktop `page.js` with accessible controls. No external
network is needed while measuring. Receipt `receivedWall` is the host arrival
time; the page's event/start/stop timestamps share the guest clock. Never
subtract those two clocks without measuring their offset/uncertainty.

## Cell protocol and evidence

Use at least five runs per applicable cell. Give every run a fresh recording
id (edit the id field using the bound command). Start capture with its button;
wait for committed chunks, record a snapshot, and save a Device screenshot.
Use a fresh document to recover persisted chunks with the same recording id.
Export receipts and readback before starting another run. Preserve origin and
browser profile across kill/relaunch. Never clear storage between interruption
and readback. State exactly how an interruption was observed, not just requested.

| Cell | Required mechanism and acceptance evidence |
| --- | --- |
| close-tab | Bound UI command closes the recording tab; read from a fresh tab; observe tab disappearance. |
| crash-renderer | Use only a supported bound operation; observe renderer crash and successful fresh-document readback. If unavailable, record the exact limitation. |
| kill-browser | Use only a supported bound operation; establish actual process death from permitted logs/process inspection before relaunch. Graceful close is not SIGKILL. |
| hidden-then-kill | Bound operation backgrounds browser; page reports hidden throughout the interval (6 s baseline); observe death and recover. |
| track-ended | Press “Simulate track end”; observe inactive recorder, drained write chain and ended tracks. Always label this **simulated**. |
| quota | Provision an owned bounded storage fixture; observe a real failed write and stop/drain. JS-thrown QuotaExceededError is only simulated. Never fill shared host or emulator storage. |
| OS mic interruption | Establish a real audio input first; use a supported controller operation to interrupt it; correlate OS evidence with track/recorder events. A fake stream or app permission revocation that kills the browser is not an incoming-call result. |
| lock/background freeze | Bound operation locks/backgrounds; confirm actual lock independently. Confirm freezing with freeze/resume events or a measured chunk-delivery pause/resumption under continuing capture. Hidden visibility, an API acknowledgement or delayed HTTP receipts alone do not establish freezing. |

For each completed run retain `before`, guest interruption wall time, observed
mechanism, `read` result, screenshot paths and exact source/browser/tool/image
versions. Calculate `capturedMs = interruptionWall - startWall`, index loss =
`capturedMs - read.index.savedThroughMs`, playable loss =
`capturedMs - read.decodedMs`. Refuse unreadable/noncontiguous chunks, missing
index, decode failure or unobserved interruption as a measured loss sample.
For event-driven stops use the page's stopWall after its chain drains. For
external interruption establish guest-clock timing with uncertainty first;
the page control scaffold does not yet automate that timing or the eight-cell
runner. Report min/median/max and raw arrays plus survival rows and capability
facts in the #1010 format. Do not promise a one-second bound.

Classify completed cells as measured, explicitly simulated or explicitly
unproducible **with runtime evidence**. Tool access failure leaves cells
**not measured (blocked)**; it does not prove an emulator capability is absent.
Screen lock can be measured while freeze remains unproducible. Safari macOS
and iOS remain not measured, regardless of Android output.

## Independent reproduction and cleanup

A second agent must start from these steps alone, report exact pins, a passing
doctor and at least one probe run with Device evidence. Setup inventory and
this first agent's work cannot satisfy that criterion. Do not close #1236 on
setup success; reconcile #1010 only after measurements exist.

Stop the owned fixture server and emulator, remove only this invocation's adb
forward, and preserve the AVD/results for reproduction unless their deletion
was requested. Do not close another thread's Device session. Sanitize raw
logs/JSON/screenshots before publication: no host/account names, absolute
personal paths, device/session identifiers or remote endpoints. Keep original
logs private and retain exact generic tool versions in the public finding.

Harness-only verification (no emulator or network):

```sh
bun run test experiments/android-audio-inventory.test.ts
node --check scripts/probes/audio-commit-boundary/android-server.mjs
```

Authoritative sources: [SDK command-line tools](https://developer.android.com/tools),
[emulator startup](https://developer.android.com/studio/run/emulator-commandline),
[Google SDK catalogue](https://dl.google.com/android/repository/repository2-1.xml),
[Google APIs image catalogue](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-1.xml),
[agent-device commands](https://github.com/callstack/agent-device/blob/main/website/docs/docs/commands.md).
Installed `agent-device help doctor`, `help cdp` and `help settings` are the
version-specific command authority; current upstream main may differ.
