# Dependency setup precedes offline runtime; tests never install packages.
FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends btrfs-progs util-linux python3 bubblewrap libseccomp2 git iproute2 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["python3"]
