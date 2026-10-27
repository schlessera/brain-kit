"""Output-only evaluation helper: raw WAV replay files plus final-second waveform/RMS.
Usage: python3 plot.py CAPTURE_DIRECTORY --end CONTEXT_SECONDS
The provider waveform is placed with playback-scheduled events, not file EOF.
Cuts/suppression can mean not all received bytes were scheduled. Never infer at-ear output.
"""
import argparse, json, pathlib, struct
import numpy as np
import matplotlib.pyplot as plt
p = argparse.ArgumentParser()
p.add_argument('directory', type=pathlib.Path)
p.add_argument('--end', type=float, required=True, help='end of comparison window in AudioContext seconds')
a = p.parse_args()
m = json.loads((a.directory/'metadata.json').read_text())
if not m['complete']:
    raise ValueError('Incomplete capture: inspect gap/cap metadata before plotting a tail comparison')
def read(name, dtype):
    b = (a.directory/name).read_bytes()
    assert b[:4] == b'RIFF' and b[8:12] == b'WAVE' and b[36:40] == b'data'
    return np.frombuffer(b[44:], dtype=dtype).astype(float)
provider = read('provider.wav', '<i2') / 32768
mix = read('mix.wav', '<f4')
# Find an explicit source-byte/context-time anchor near the requested window.
# This maps scheduled bytes only; suppressed output is retained in the raw WAV.
anchors = [e for e in m["events"] if e["kind"] == "playback-scheduled" and e.get("providerByteOffset", -1) >= 0 and e["start"] <= a.end]
if not anchors:
    raise ValueError("No scheduled provider-byte anchor; choose a paired window from metadata")
anchor = anchors[-1]
provider_end = anchor["providerByteOffset"]/2/m["provider"]["sampleRate"] + a.end-anchor["start"]
fig, axes = plt.subplots(2, 1, figsize=(12, 6), sharey=True)
for ax, label, data, rate, offset in [(axes[0], 'Adapter-received provider PCM (arrival concatenation; own clock)', provider, m['provider']['sampleRate'], 0), (axes[1], 'Playback mix BEFORE driver/headphones (context clock)', mix, m['mix']['sampleRate'], m['mix']['firstFrame']/m['mix']['sampleRate'])]:
    end = a.end if ax == axes[1] else provider_end
    t = np.arange(len(data))/rate+offset
    mask = (t >= end-1.2) & (t <= end+.2)
    ax.plot(t[mask], data[mask], linewidth=.5, label='raw waveform')
    window = max(1, round(rate*.01))
    n = len(data)//window
    rms = np.sqrt(np.mean(data[:n*window].reshape(n, window)**2, axis=1))
    rt = (np.arange(n)*window+window/2)/rate+offset
    take = (rt >= end-1.2) & (rt <= end+.2)
    ax.plot(rt[take], rms[take], label='10 ms RMS', linewidth=1.2)
    ax.set(title=label, ylim=(-1, 1), xlim=(end-1.2, end+.2), xlabel='Seconds'); ax.legend(); ax.grid(alpha=.2)
for e in m['events']:
    if e['kind'] in ('playback-cut', 'playback-flush', 'conversation-closed'):
        axes[1].axvline(e['contextTime'], color='red', alpha=.6)
fig.suptitle('EVALUATION ONLY · explicit schedule anchor, no normalization / smoothing / trimming')
fig.tight_layout(); fig.savefig(a.directory/'tail-waveform-rms.png', dpi=160)
print('Capture complete:', m['complete'], 'issues:', m['issues'])
