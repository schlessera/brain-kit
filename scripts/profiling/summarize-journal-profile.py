"""Summarize original receipts without replacing them; times are fixture wall time."""
import argparse
import json
import pathlib
import statistics

p = argparse.ArgumentParser()
p.add_argument("bundle", type=pathlib.Path)
a = p.parse_args()
samples = json.loads((a.bundle / "pilot-profile.json").read_text())["samples"] + json.loads((a.bundle / "complete-profile.json").read_text())["samples"]
for workload in ("small", "large"):
    selected = [s for s in samples if s["workload"]["name"] == workload]
    if len(selected) != 3:
        raise RuntimeError(f"{workload}: expected three completed samples, got {len(selected)}")
    for phase in ("coldAdmission", "firstChanged", "warmUnchanged", "warmChanged"):
        rows = [next(p for p in s["phases"] if p["name"] == phase) for s in selected]
        wall = [r["elapsedMs"] / 1000 for r in rows]
        accounting = [sum(r["counters"].get(k, {}).get("ms", 0) for k in ("accountingReserve", "accountingFinish", "accountingWrite")) / 1000 for r in rows]
        print(json.dumps({"workload": workload, "phase": phase, "n": len(rows), "wallSeconds": {"min": min(wall), "median": statistics.median(wall), "max": max(wall)},
            "accountingSeconds": {"min": min(accounting), "median": statistics.median(accounting), "max": max(accounting)},
            "accountingPercentEachSample": [a / w * 100 for a, w in zip(accounting, wall)],
            "retainCallsEachSample": [r["counters"].get("objectRetainIncludingAccounting", {}).get("calls", 0) for r in rows],
            "checkpointCallsEachSample": [r["counters"].get("nativeCheckpoint", {}).get("calls", 0) for r in rows]}))
