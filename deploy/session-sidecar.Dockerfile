# Session sidecar: a normal headless Chromium that signs in with the owner's
# credentials and exports only a SHORT-LIVED token snapshot for the gateway.
# The Playwright base image already contains Chromium and all system libraries.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app
# Reuse the browser bundled in the base image; do not download another copy.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

COPY validation/package.json validation/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY validation/session-sidecar.mjs validation/session-refresh-policy.mjs ./

# Same identity as the gateway image: the snapshot files are 0600 and the gateway
# runs as 10001, so both sides must share that uid.
RUN mkdir -p /state /session && chown -R 10001:10001 /state /session /app
USER 10001:10001
# Chromium writes its profile and caches under HOME.
ENV HOME=/state

ENTRYPOINT ["node", "/app/session-sidecar.mjs"]
