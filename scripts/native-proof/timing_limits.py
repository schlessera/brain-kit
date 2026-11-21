"""Pure watchdog calculation shared by the fixture and its keyless proof."""
import json, math, sys


def hosted_timeout_seconds(env):
    raw_factor = env.get("BRAIN_TEST_DEADLINE_FACTOR") or "1"
    factor = int(raw_factor)
    if str(factor) != raw_factor or not 1 <= factor <= 100:
        raise ValueError("Invalid deadline factor")
    if env.get("BRAIN_NATIVE_PROOF_OBSERVATION_TIMING") != "1":
        apply = env.get("BRAIN_NATIVE_PROOF_APPLY_TIMING") == "1"
        return max(300 if apply else 180, math.ceil((240 if apply else 120) * factor) + 60)
    raw = env.get("BRAIN_NATIVE_PROOF_TREE")
    sizes = json.loads(raw) if raw else None
    entries = sum(sizes[key] for key in ("workspaceEntries", "dependencyEntries", "journalObjects")) + 4 * sizes["checkouts"] if sizes else 0
    # Bun scales its per-test timeout once; leave two minutes for setup/cleanup.
    inner_ms = max(1500000, (120000 + 2 * entries) * 15 if sizes else 0) * factor
    return max(1800, math.ceil(inner_ms / 1000) + 120)



if __name__ == "__main__":
    print(hosted_timeout_seconds(json.loads(sys.argv[1])))
