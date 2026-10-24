FROM rust:1.91.1-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# Version-pinned public frontend patches; no account/session state is copied.
COPY frontend ./frontend
# Build inside the container; no host toolchain is needed. The manifest requires Rust >= 1.88.
# Dependency resolution is pinned by the checked-in lock; never update it during image builds.
RUN cargo test --locked && cargo build --release --locked

# Export only the non-secret dependency lock from the verified builder when needed.
FROM scratch AS lockfile
COPY --from=builder /build/Cargo.lock /Cargo.lock

FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.title="skylit-gateway" \
      org.opencontainers.image.description="Fixed-origin Rust gateway with per-device state for a single owner's Skylit session" \
      org.opencontainers.image.source="https://github.com/MrHuangJser/skylit-gateway"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder --chown=10001:10001 /build/target/release/skylit-gateway /app/skylit-gateway
# The captured frontend snapshot (shell + chunks + fonts). Serving these locally keeps the
# adapter pinned to one build, so an upstream deploy cannot rename the chunks under it.
COPY --from=builder --chown=10001:10001 /build/frontend/mirror /app/frontend-mirror
ENV FRONTEND_MIRROR_DIR=/app/frontend-mirror
# A numeric non-root UID/GID needs no shell account or writable application directory.
USER 10001:10001
EXPOSE 8080
# Required at runtime: GATEWAY_ACCESS_TOKEN and PUBLIC_ORIGIN. COOKIE_SECURE defaults to true.
ENTRYPOINT ["/app/skylit-gateway"]
