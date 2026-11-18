# Dependency setup precedes offline runtime; tests never install packages.
FROM ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
# Bound all mirror retries below the workflow's 12-minute prerequisite budget.
# Error-Mode=any prevents a partial index refresh from masquerading as success.
RUN timeout --kill-after=10s 600s sh -ec ' \
    for attempt in 1 2 3; do \
        if apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o APT::Update::Error-Mode=any update; then break; fi; \
        if [ "$attempt" = 3 ]; then exit 1; fi; \
        sleep 5; \
    done; \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends btrfs-progs util-linux python3 bubblewrap libseccomp2 git iproute2 openssl ca-certificates; \
    rm -rf /var/lib/apt/lists/*'
ENTRYPOINT ["python3"]
