# Runtime image for task-eval tool subprocess isolation (tag: pi-smart-compact-task-eval:runtime-1).
# Build from an empty context; this file copies no repository or host data.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM node:lts-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS rootfs
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ripgrep=13.0.0-4+b2 \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Flatten so the image carries no inherited ENV/ENTRYPOINT/CMD; the sandbox supplies the exact env.
FROM scratch
COPY --from=rootfs / /
