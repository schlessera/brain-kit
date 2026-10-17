"""Networked preparation only. Runtime probes never use registry access."""
import base64
import hashlib
import json
import pathlib
import sys
import tarfile
import urllib.request

destination = pathlib.Path(sys.argv[1]).resolve()
destination.mkdir(parents=True, exist_ok=False)
identities = {
    "0.27.0": "402fea298e6e38e5da9b302307599ebc5ded30a14e6a637c1410161add17315a",
    "0.41.0": "68c4eb20216fe77fe69b0fcdb24e03c0cc6e0c7cc7bad8e88b47373da1c91aec",
}
for version, expected in identities.items():
    with urllib.request.urlopen("https://registry.npmjs.org/pi-web-access/" + version) as response:
        metadata = json.load(response)
    with urllib.request.urlopen(metadata["dist"]["tarball"]) as response:
        data = response.read()
    algorithm, integrity = metadata["dist"]["integrity"].split("-", 1)
    assert base64.b64encode(hashlib.new(algorithm, data).digest()).decode() == integrity
    assert hashlib.sha256(data).hexdigest() == expected
    (destination / (version + "-registry.json")).write_text(json.dumps(metadata, indent=2))
    archive = destination / (version + ".tgz")
    archive.write_bytes(data)
    with tarfile.open(archive) as packed:
        packed.extractall(destination / version, filter="data")
    print(version, expected, metadata.get("gitHead"))
